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

// Platform-specific configuration templates
const PLATFORM_CONFIGS = {
  youtube: {
    extractorArgs: {
      youtube: {
        skip_webpage: true,
        player_client: "android"
      }
    },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    referer: "https://www.youtube.com/"
  },
  instagram: {
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    referer: "https://www.instagram.com/",
    forceIpv4: true,
    proxy: process.env.INSTAGRAM_PROXY || ""
  },
  facebook: {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    extractorArgs: {
      facebook: {
        skip_auth: true,
        skip_web_fallback: true
      }
    }
  },
  default: {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    referer: "https://www.google.com/"
  }
};

// Unified function to build options
const buildPlatformOptions = (platform) => {
  return {
    noCheckCertificates: true,
    noWarnings: true,
    ...PLATFORM_CONFIGS[platform],
    ...PLATFORM_CONFIGS.default // Fallback to defaults
  };
};

// Build ytdl options with platform config
const buildYtdlOptions = (url, extraOptions = {}) => {
  const { config } = url;
  const baseOptions = {
    noCheckCertificates: true,
    noWarnings: true,
    ...config
  };

  // Add cookies if available
  if (config.cookies && config.cookies.trim() !== '') {
    baseOptions.cookies = config.cookies;
  }

  // Add proxy if available
  if (config.proxy && config.proxy.trim() !== '') {
    baseOptions.proxy = config.proxy;
  }

  return { ...baseOptions, ...extraOptions };
};

// Get available formats
const getFormats = async (url) => {
  try {
    const options = buildYtdlOptions(url, {
      dumpSingleJson: true,
      preferFreeFormats: true
    });

    const info = await ytdl(url, options);

    return info.formats
      .filter(f => f.vcodec !== 'none' && f.acodec !== 'none')
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

// Get video preview with retry logic
const getVideoPreview = async (url) => {
  const maxRetries = 3;
  let retries = 0;
  
  while (retries <= maxRetries) {
    try {
      const options = {
      dumpSingleJson: true,
      skipDownload: true,
      ...buildPlatformOptions(url.platform) 
    };

      const info = await ytdl(url, options);
      
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
      retries++;
      
      if (retries > maxRetries) {
        console.error('Preview error:', error);
        throw new Error('Failed to get video preview: ' + error.message);
      }
      
      // Add delay before retrying
      await new Promise(resolve => setTimeout(resolve, 1000 * retries));
    }
  }
};

// Get stream URL
const getStreamUrl = async (url, format) => {
  const options = {
    format: format || 'best',
    output: '-', // Stream to stdout
    mergeOutputFormat: 'mp4',
    ...buildPlatformOptions(url.platform)
  };

  const info = await ytdl(url, options);

  // 1) Prefer HLS (manifest) formats
  const hlsFormat = info.formats.find(f =>
    f.ext === 'm3u8_native' || f.protocol === 'm3u8_native' || (f.url && f.url.includes('.m3u8'))
  );
  
  if (hlsFormat && hlsFormat.url) {
    return {
      url: hlsFormat.url,
      format: hlsFormat.format_id,
      duration: info.duration,
      title: info.title
    };
  }

  // 2) Use requested format if available
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

  // 3) Fallback to best progressive format
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
  const id = uuidv4();
  const output = path.join(DOWNLOAD_DIR, `${id}.%(ext)s`);

  // Create progress emitter
  const progressEmitter = new DownloadProgressEmitter();
  progressEmitters.set(id, progressEmitter);

  // Store initial state
  downloads.set(id, {
    id,
    url: url,
    format,
    status: 'downloading',
    progress: 0,
    filePath: null,
    error: null,
  });

  // Run download in background
  (async () => {
    try {
      const options = buildYtdlOptions(url);
      const args = [
        urlInfo.url,
        '-o', output,
      ];
      
      if (format) {
        args.push('-f', format);
      }

      // Add platform-specific options
      if (options.cookies) {
        args.push('--cookies', options.cookies);
      }
      if (options.proxy) {
        args.push('--proxy', options.proxy);
      }
      if (options.userAgent) {
        args.push('--user-agent', options.userAgent);
      }
      if (options.referer) {
        args.push('--referer', options.referer);
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

// Setup SSE stream
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

// Stream video to frontend directly
const streamDownload = async (url, format, res) => {
  try {
    // Get video metadata
    const options = {
    format: format || 'best',
    output: '-', // Stream to stdout
    mergeOutputFormat: 'mp4',
    ...buildPlatformOptions(url.platform)
  };
    
    const info = await ytdl(url, options);
    
    const safeTitle = info.title.replace(/[^\w\s]/gi, '');
    const extension = format && format.includes('mp4') ? 'mp4' : 'mp4';
    
    // Set proper headers
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.${extension}"`);

    // Build arguments
    const args = [
      url,
      '-f', format || 'best',
      '-o', '-',
      '--no-part',
      '--no-check-certificate',
      '--merge-output-format', 'mp4'
    ];

    // Add platform-specific options
    if (url.config.cookies) {
      args.push('--cookies', url.config.cookies);
    }
    if (url.config.proxy) {
      args.push('--proxy', url.config.proxy);
    }
    if (url.config.userAgent) {
      args.push('--user-agent', url.config.userAgent);
    }
    if (url.config.referer) {
      args.push('--referer', url.config.referer);
    }

    // Spawn yt-dlp process
    const ytdlProc = spawn(ytdlPath, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // Pipe stdout to response
    ytdlProc.stdout.pipe(res);

    // Handle errors
    ytdlProc.stderr.on('data', data => {
      console.error('[yt-dlp stderr]', data.toString());
    });

    ytdlProc.on('error', (err) => {
      console.error('Failed to spawn yt-dlp:', err);
      if (!res.headersSent) res.status(500).end('Download failed');
    });

    ytdlProc.on('close', (code) => {
      if (code !== 0) {
        console.error(`yt-dlp exited with code ${code}`);
        if (!res.headersSent) res.status(500).end('Download failed');
      }
    });

    // Handle client disconnect
    res.on('close', () => {
      if (!ytdlProc.killed) {
        ytdlProc.kill('SIGTERM');
      }
    });

    // Set timeout to prevent hanging
    res.setTimeout(300000, () => {
      if (!res.headersSent) {
        res.status(504).end('Download timeout');
        ytdlProc.kill('SIGTERM');
      }
    });

  } catch (err) {
    console.error('Streaming error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'Stream failed' });
    }
  }
};

module.exports = {
  getFormats,
  getVideoPreview,
  getStreamUrl,
  startDownload,
  setupProgressStream,
  getDownloadStatus,
  scheduleFileDeletion,
  streamDownload
};
