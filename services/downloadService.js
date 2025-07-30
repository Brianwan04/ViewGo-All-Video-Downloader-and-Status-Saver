// services/downloadService.js
const ytdl = require('yt-dlp-exec');
const path = require('path');
const ytdlPath = path.join(__dirname, '../bin/yt-dlp');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');
const { validateUrl } = require('../utils/validation');
const { spawn } = require('child_process');

// Get DOWNLOAD_DIR from environment
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(__dirname, '../downloads');

// Track downloads in memory
const downloads = new Map();
const progressEmitters = new Map();

class DownloadProgressEmitter extends EventEmitter {}

// Get available formats
const getFormats = async (url) => {
  url = validateUrl(url);
  try {
    const info = await ytdl(url, {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
    });

    return info.formats
      .filter(f => f.vcodec !== 'none' && f.acodec !== 'none') // ✅ Ensure both video & audio
      .map(f => ({
        format_id: f.format_id,
        ext: f.ext,
        resolution: f.resolution || `${f.height}p` || 'unknown',
        format_note: f.format_note,
        filesize: f.filesize,
      }));
  } catch (error) {
    throw new Error('Failed to get formats: ' + error.message);
  }
};


// Get video preview
const getVideoPreview = async (url) => {
  url = validateUrl(url);
  try {
    const info = await ytdl(url, {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      skipDownload: true,
    });
    
    return {
      id: info.id || url,
      title: info.title,
      thumbnail: info.thumbnail,
      duration: info.duration,
      platform: info.extractor_key,
      uploader: info.uploader,
      view_count: info.view_count,
    };
  } catch (error) {
    throw new Error('Failed to get video preview: ' + error.message);
  }
};

// Get stream URL
const getStreamUrl = async (url, format) => {
  url = validateUrl(url);

  // Ask ytdl to list all formats (no download)
  const info = await ytdl(url, {
    dumpSingleJson: true,
    noCheckCertificates: true,
    noWarnings: true,
    skipDownload: true
  });

  // 1) Prefer HLS (manifest) formats
  const hlsFormat = info.formats.find(f =>
    f.ext === 'm3u8_native' || (f.protocol === 'm3u8_native') || (f.url && f.url.includes('.m3u8'))
  );
  if (hlsFormat && hlsFormat.url) {
    return {
      url: hlsFormat.url,
      format: hlsFormat.format_id,
      duration: info.duration,
      title: info.title
    };
  }

  // 2) Otherwise, if caller specified a format, use that
  if (format) {
    const chosen = info.formats.find(f => f.format_id === format);
    if (chosen && chosen.url) {
      return {
        url: chosen.url,
        format: chosen.format_id,
        duration: info.duration,
        title: info.title
      };
    }
  }

  // 3) Fallback: best progressive MP4
  const progressive = info.formats
    .filter(f => f.protocol === 'https' && f.vcodec !== 'none' && f.acodec !== 'none')
    .sort((a, b) => (b.filesize || 0) - (a.filesize || 0))[0];

  if (progressive && progressive.url) {
    return {
      url: progressive.url,
      format: progressive.format_id,
      duration: info.duration,
      title: info.title
    };
  }

  throw new Error('No suitable stream format found');
};


// Start a download
const startDownload = async (url, format) => {
  url = validateUrl(url);
  const id = uuidv4();
  const output = path.join(DOWNLOAD_DIR, `${id}.%(ext)s`);

  // Create progress emitter
  const progressEmitter = new DownloadProgressEmitter();
  progressEmitters.set(id, progressEmitter);

  // Store initial state
  downloads.set(id, {
    id,
    url,
    format,
    status: 'downloading',
    progress: 0,
    filePath: null,
    error: null,
  });

  // Run download in background
  (async () => {
    try {
      const args = [
        url,
        '-o', output,
        '--no-check-certificates',
      ];
      
      if (format) {
        args.push('-f', format);
      }

      const ytdlProcess = ytdl.exec(args);

      // Parse progress
      ytdlProcess.stderr.on('data', (data) => {
        const line = data.toString();
        const match = line.match(/\[download\]\s+(\d+\.\d+)%/);
        if (match) {
          const progress = parseFloat(match[1]);
          const download = downloads.get(id);
          download.progress = progress;
          progressEmitter.emit('progress', progress);
        }
      });

      // Wait for completion
      await ytdlProcess;
      
      // Find actual output file
      const files = fs.readdirSync(DOWNLOAD_DIR);
      const outputFile = files.find(f => f.startsWith(id));
      
      if (outputFile) {
        const filePath = path.join(DOWNLOAD_DIR, outputFile);
        downloads.get(id).status = 'completed';
        downloads.get(id).filePath = filePath;
        progressEmitter.emit('completed', filePath);
        
        // Schedule file deletion
        scheduleFileDeletion(filePath);
      } else {
        throw new Error('Output file not found');
      }
    } catch (error) {
      downloads.get(id).status = 'error';
      downloads.get(id).error = error.message;
      console.error('[Download Error]', error);
progressEmitter.emit('error', error.message || 'Unknown error');

    }
  })();

  return id;
};

// Setup SSE stream - FIXED VERSION
const setupProgressStream = (id, res) => {
  const progressEmitter = progressEmitters.get(id);
  if (!progressEmitter) {
    return res.status(404).end();
  }

  // SAFETY: Check if headers are already sent
  if (res.headersSent) {
    console.error('Headers already sent for', id);
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  // Monkey-patch res.flush if missing
  if (typeof res.flush !== 'function') {
    res.flush = () => {}; // No-op function
  }

  res.flushHeaders();

  // SAFE event sender
  const sendEvent = (event, data) => {
    try {
      // Critical: Check if response is still writable
      if (res.writableEnded || !res.writable) {
        progressEmitter.removeAllListeners();
        return;
      }
      
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      res.flush();
    } catch (err) {
      console.error('SSE write error:', err.message);
      progressEmitter.removeAllListeners();
    }
  };

  // Send initial progress
  const download = downloads.get(id);
  if (download) {
    sendEvent('progress', { progress: download.progress });
  }

  // Listen for updates
  const onProgress = (progress) => sendEvent('progress', { progress });
  const onCompleted = (filePath) => {
    const filename = path.basename(filePath);
    sendEvent('completed', { downloadUrl: `/downloads/${filename}` });
  };
  const onError = (error) => {
    const safeError = typeof error === 'string' ? error : (error?.message || 'Unknown error');
    sendEvent('error', { error: safeError });
  };
  

  progressEmitter.on('progress', onProgress);
  progressEmitter.on('completed', onCompleted);
  progressEmitter.on('error', onError);

  // Cleanup on disconnect
  res.on('close', () => {
    progressEmitter.off('progress', onProgress);
    progressEmitter.off('completed', onCompleted);
    progressEmitter.off('error', onError);
    res.end();
  });
};

// Get download status
const getDownloadStatus = (id) => {
  const status = downloads.get(id);
  if (!status) throw new Error('Download not found');
  return { ...status };
};

// Schedule file deletion
const scheduleFileDeletion = (filePath) => {
  const retentionMinutes = parseInt(process.env.FILE_RETENTION_MINUTES || '30');
  setTimeout(() => {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`Deleted file: ${filePath}`);
    }
  }, retentionMinutes * 60 * 1000);
};

const { PassThrough } = require('stream');

const streamVideoDirectly = async (req, res) => {
  const url = validateUrl(req.query.url);
  const format = req.query.format || 'best';

  res.setHeader('Content-Type', 'video/mp4');

  const args = [
    url,
    '-f', format,
    '-o', '-',
    '--no-check-certificates'
  ];
  const ytdlProcess = spawn(ytdlPath, args);

  const passthrough = new PassThrough();

  ytdlProcess.stdout.pipe(passthrough).pipe(res);

  ytdlProcess.stderr.on('data', (data) => {
    console.log('[yt-dlp stderr]', data.toString());
  });

  ytdlProcess.on('error', (err) => {
    console.error('[yt-dlp stream error]', err);
    if (!res.headersSent) res.status(500).end('Stream error');
  });

  ytdlProcess.on('close', (code) => {
    if (code !== 0) {
      console.error(`[yt-dlp] exited with code ${code}`);
    }
  });
};

// New: Stream video to frontend directly without saving to disk
const streamDownload = async (url, format, res) => {
  try {
    const args = [
      url,
      '-f', format || 'best',
      '-o', '-', // stream to stdout
      '--no-part',
      '--no-check-certificate'
    ];

    const proc = spawn(ytdlPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    // Optional: set headers
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="video.mp4"');

    // Pipe video data
    proc.stdout.pipe(res);

    proc.stderr.on('data', (data) => {
      console.error('[yt-dlp stderr]', data.toString());
    });

    proc.on('error', (err) => {
      console.error('Failed to spawn yt-dlp:', err.message);
      if (!res.headersSent) res.status(500).end('Spawn failed');
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        console.error(`yt-dlp exited with code ${code}`);
        if (!res.headersSent) res.status(500).end('yt-dlp error');
      }
    });

  } catch (err) {
    console.error('Streaming error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Stream failed' });
    }
  }
};


// Export all functions

module.exports = {
  getFormats,
  getVideoPreview,
  getStreamUrl,
  startDownload,
  setupProgressStream,
  getDownloadStatus,
  scheduleFileDeletion,
  streamVideoDirectly,
  streamDownload
};
