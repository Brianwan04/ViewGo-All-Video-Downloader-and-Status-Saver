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



// Helper to extract video URL from input

const getVideoUrl = (input) => {

  return (typeof input === 'string') ? input : input.url;

};



// Unified function to build options

const buildYtdlOptions = (input, extraOptions = {}) => {

  // Safely extract config and platform

  const config = (input && typeof input === 'object') ? input.config || {} : {};

  const platform = (input && typeof input === 'object') ? input.platform || 'default' : 'default';



  // Build base options with proper merging order

  const baseOptions = {

    noCheckCertificates: true,

    noWarnings: true,

    ...PLATFORM_CONFIGS.default,

    ...(PLATFORM_CONFIGS[platform] || {}),

    ...config

  };



  // Clean empty values


  if (baseOptions.cookies && baseOptions.cookies.trim() === '') {


    delete baseOptions.cookies;


  }


  if (baseOptions.cookies && baseOptions.cookies.trim() !== '') {


  // Use HTTP header instead of cookie file


  baseOptions.addHeader = [`cookie: ${baseOptions.cookies.trim()}`];


  delete baseOptions.cookies;


}

  if (baseOptions.proxy && baseOptions.proxy.trim() === '') {

    delete baseOptions.proxy;

  }



  return { ...baseOptions, ...extraOptions };

};



// Get available formats

const getFormats = async (url) => {

  try {

    const videoUrl = getVideoUrl(url);

    const options = buildYtdlOptions(url, {

      dumpSingleJson: true,

      preferFreeFormats: true

    });



    const info = await ytdl(videoUrl, options);



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

  const videoUrl = getVideoUrl(url);



  while (retries <= maxRetries) {

    try {

      const options = buildYtdlOptions(url, {

        dumpSingleJson: true,

        skipDownload: true

      });



      const info = await ytdl(videoUrl, options);



      return {

        id: info.id || videoUrl,

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

      await new Promise(resolve => setTimeout(resolve, 1000 * retries));

    }

  }

};



// Get stream URL

const getStreamUrl = async (url, format) => {

  const videoUrl = getVideoUrl(url);

  const options = buildYtdlOptions(url, {

    format: format || 'best',

    dumpSingleJson: true

  });



  const info = await ytdl(videoUrl, options);



  // 1) Prefer HLS formats

  const hlsFormat = info.formats.find(f => 

    f.ext === 'm3u8_native' || 

    f.protocol === 'm3u8_native' || 

    (f.url && f.url.includes('.m3u8'))

  );



  if (hlsFormat?.url) {

    return {

      url: hlsFormat.url,

      format: hlsFormat.format_id,

      duration: info.duration,

      title: info.title

    };

  }



  // 2) Use requested format

  if (format) {

    const chosen = info.formats.find(f => f.format_id === format);

    if (chosen?.url) {

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



  if (progressive?.url) {

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

  const videoUrl = getVideoUrl(url);



  // Create progress emitter

  const progressEmitter = new DownloadProgressEmitter();

  progressEmitters.set(id, progressEmitter);



  // Store initial state

  downloads.set(id, {

    id,

    url: videoUrl,

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

        videoUrl,

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


      if (options.addHeader) {


  options.addHeader.forEach(hdr => args.push('--add-header', hdr));


}


if (options.userAgent) args.push('--user-agent', options.userAgent);



      const ytdlProcess = ytdl.exec(args);



      // Parse progress

      ytdlProcess.stderr.on('data', (data) => {

        const line = data.toString();

        const match = line.match(/\[download\]\s+(\d+\.\d+)%/);

        if (match) {

          const progress = parseFloat(match[1]);

          const download = downloads.get(id);

          if (download) {

            download.progress = progress;

            progressEmitter.emit('progress', progress);

          }

        }

      });



      // Wait for completion

      await ytdlProcess;



      // Find actual output file

      const files = fs.readdirSync(DOWNLOAD_DIR);

      const outputFile = files.find(f => f.startsWith(id));



      if (outputFile) {

        const filePath = path.join(DOWNLOAD_DIR, outputFile);

        const download = downloads.get(id);

        if (download) {

          download.status = 'completed';

          download.filePath = filePath;

        }

        progressEmitter.emit('completed', filePath);

        scheduleFileDeletion(filePath);

      } else {

        throw new Error('Output file not found');

      }

    } catch (error) {

      const download = downloads.get(id);

      if (download) {

        download.status = 'error';

        download.error = error.message;

      }

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



  if (res.headersSent) {

    console.error('Headers already sent for', id);

    return;

  }



  res.setHeader('Content-Type', 'text/event-stream');

  res.setHeader('Cache-Control', 'no-cache');

  res.setHeader('Connection', 'keep-alive');



  if (typeof res.flush !== 'function') {

    res.flush = () => {};

  }



  res.flushHeaders();



  const sendEvent = (event, data) => {

    try {

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



  const download = downloads.get(id);

  if (download) {

    sendEvent('progress', { progress: download.progress });

  }



  const onProgress = (progress) => sendEvent('progress', { progress });

  const onCompleted = (filePath) => {

    const filename = path.basename(filePath);

    sendEvent('completed', { downloadUrl: `/downloads/${filename}` });

  };

  const onError = (error) => {

    sendEvent('error', { error: typeof error === 'string' ? error : (error?.message || 'Unknown error') });

  };



  progressEmitter.on('progress', onProgress);

  progressEmitter.on('completed', onCompleted);

  progressEmitter.on('error', onError);



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

    try {

      if (fs.existsSync(filePath)) {

        fs.unlinkSync(filePath);

        console.log(`Deleted file: ${filePath}`);

      }

    } catch (err) {

      console.error('File deletion error:', err.message);

    }

  }, retentionMinutes * 60 * 1000);

};



// Stream video to frontend directly

const streamDownload = async (url, format, res) => {

  const videoUrl = getVideoUrl(url);



  try {

    const options = buildYtdlOptions(url, {

      dumpSingleJson: true,

      format: format || 'best'

    });



    const info = await ytdl(videoUrl, options);

    const safeTitle = (info.title || 'video').replace(/[^\w\s]/gi, '');

    const extension = format && format.includes('mp4') ? 'mp4' : 'mp4';



    res.setHeader('Content-Type', 'video/mp4');

    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.${extension}"`);



    const args = [

      videoUrl,

      '-f', format || 'best',

      '-o', '-',

      '--no-part',

      '--no-check-certificates',

      '--merge-output-format', 'mp4'

    ];




    if (options.addHeader) {


  options.addHeader.forEach(hdr => args.push('--add-header', hdr));


}


if (options.userAgent) args.push('--user-agent', options.userAgent);




    // Add platform-specific options

    const config = buildYtdlOptions(url);

    if (config.cookies) {

      args.push('--cookies', config.cookies);

    }

    if (config.proxy) {

      args.push('--proxy', config.proxy);

    }

    if (config.userAgent) {

      args.push('--user-agent', config.userAgent);

    }

    if (config.referer) {

      args.push('--referer', config.referer);

    }



    const ytdlProc = spawn(ytdlPath, args, {

      stdio: ['ignore', 'pipe', 'pipe']

    });



    ytdlProc.stdout.pipe(res);



    ytdlProc.stderr.on('data', data => {

      console.error('[yt-dlp stderr]', data.toString());

    });



    ytdlProc.on('error', (err) => {

      console.error('Failed to spawn yt-dlp:', err);

      if (!res.headersSent) res.status(500).end('Download failed');

    });



    ytdlProc.on('close', (code) => {

      if (code !== 0 && !res.headersSent) {

        res.status(500).end('Download failed');

      }

    });



    res.on('close', () => {

      if (!ytdlProc.killed) ytdlProc.kill('SIGTERM');

    });



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
