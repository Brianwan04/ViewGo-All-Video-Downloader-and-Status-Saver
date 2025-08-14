const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');
const ytdl = require('yt-dlp-exec');
const ytdlPath = path.join(__dirname, '../bin/yt-dlp');
const { validateUrl } = require('../utils/validation');

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(__dirname, '../downloads');

const downloads = new Map();
const progressEmitters = new Map();

class DownloadProgressEmitter extends EventEmitter {}

const PLATFORM_CONFIGS = {
  youtube: {
    extractorArgs: {
      youtube: {
        skip_webpage: true,
        player_client: 'android',
      },
    },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    referer: 'https://www.youtube.com/',
  },
  instagram: {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    referer: 'https://www.instagram.com/',
    forceIpv4: true,
    proxy: process.env.INSTAGRAM_PROXY || '',
  },
  twitter: {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    referer: 'https://twitter.com/',
  },
  facebook: {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    extractorArgs: {
      facebook: {
        skip_auth: true,
        skip_web_fallback: true,
      },
    },
  },
  default: {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    referer: 'https://www.google.com/',
  },
};

const getPlatformConfig = (url) => {
  if (/instagram\.com/i.test(url)) return 'instagram';
  if (/(twitter\.com|x\.com)/i.test(url)) return 'twitter';
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
  if (/facebook\.com|fb\.watch/i.test(url)) return 'facebook';
  return 'default';
};

const getVideoUrl = (input) => {
  return typeof input === 'string' ? input : input.url;
};

const buildYtdlOptions = (input, extraOptions = {}) => {
  const config = typeof input === 'object' ? input.config || {} : {};
  const videoUrl = getVideoUrl(input);
  const platform = getPlatformConfig(videoUrl);

  const baseOptions = {
    noCheckCertificates: true,
    noWarnings: true,
    ...PLATFORM_CONFIGS.default,
    ...(PLATFORM_CONFIGS[platform] || {}),
    ...config,
  };

  // Instagram-specific handling
  if (platform === 'instagram') {
    if (process.env.INSTAGRAM_COOKIES) {
      baseOptions.addHeader = baseOptions.addHeader || [];
      baseOptions.addHeader.push(`cookie: ${process.env.INSTAGRAM_COOKIES}`);
    }
    if (process.env.INSTAGRAM_PROXY) {
      baseOptions.proxy = process.env.INSTAGRAM_PROXY;
    }
  }

  // Twitter-specific handling
  if (platform === 'twitter' && process.env.TWITTER_COOKIES) {
    baseOptions.addHeader = baseOptions.addHeader || [];
    baseOptions.addHeader.push(`cookie: ${process.env.TWITTER_COOKIES}`);
  }

  // Handle cookies option
  if (baseOptions.cookies && baseOptions.cookies.trim() !== '') {
    baseOptions.addHeader = [`cookie: ${baseOptions.cookies.trim()}`];
    delete baseOptions.cookies;
  }

  // Clean up empty proxy
  if (baseOptions.proxy && baseOptions.proxy.trim() === '') {
    delete baseOptions.proxy;
  }

  return { ...baseOptions, ...extraOptions };
};

const getFormats = async (url) => {
  try {
    const videoUrl = getVideoUrl(url);
    const options = buildYtdlOptions(url, {
      dumpSingleJson: true,
      preferFreeFormats: true,
    });

    const info = await ytdl(videoUrl, options);
    const resolutionLabels = {
      480: 'SD (480p)',
      720: 'HD (720p)',
      1080: 'Full HD (1080p)',
      1440: '2K (1440p)',
      2160: '4K (2160p)'
    };

    // Filter and group by resolution
    const mergedFormats = info.formats
      .filter(f => f.vcodec !== 'none' && f.acodec !== 'none')
      .reduce((acc, f) => {
        const height = f.height;
        const resolutionKey = resolutionLabels[height] || `${height}p`;
        
        if (!acc[resolutionKey] || (f.filesize || 0) > (acc[resolutionKey].filesize || 0)) {
          acc[resolutionKey] = {
            format_id: f.format_id,
            ext: f.ext,
            resolution: resolutionKey,
            filesize: f.filesize || f.filesize_approx || null,
            bitrate: f.tbr ? `${Math.round(f.tbr)}kbps` : null
          };
        }
        return acc;
      }, {});

    // Add best audio format
    const audioFormat = info.formats
      .filter(f => f.vcodec === 'none' && f.acodec !== 'none')
      .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
    
    if (audioFormat) {
      mergedFormats['audio'] = {
        format_id: audioFormat.format_id,
        ext: audioFormat.ext,
        resolution: 'Audio Only',
        filesize: audioFormat.filesize || audioFormat.filesize_approx || null,
        bitrate: audioFormat.abr ? `${Math.round(audioFormat.abr)}kbps` : null
      };
    }

    // Sort resolutions from highest to lowest
    const resolutionOrder = ['4K (2160p)', '2K (1440p)', 'Full HD (1080p)', 'HD (720p)', 'SD (480p)'];
    const formats = Object.entries(mergedFormats)
      .sort(([aKey], [bKey]) => {
        const aIndex = resolutionOrder.indexOf(aKey);
        const bIndex = resolutionOrder.indexOf(bKey);
        return (bIndex - aIndex) || bKey.localeCompare(aKey);
      })
      .map(([_, value]) => value);

    return formats;
  } catch (error) {
    throw new Error(`Failed to get formats: ${error.message}`);
  }
};

const getVideoPreview = async (url) => {
  const maxRetries = 3;
  let retries = 0;
  const videoUrl = getVideoUrl(url);

  while (retries <= maxRetries) {
    try {
      const options = buildYtdlOptions(url, {
        dumpSingleJson: true,
        skipDownload: true,
      });

      const info = await ytdl(videoUrl, options);
      return {
        id: info.id || videoUrl,
        title: info.title,
        thumbnail: info.thumbnail || (info.thumbnails && info.thumbnails[0]?.url),
        duration: info.duration,
        platform: info.extractor_key,
        uploader: info.uploader,
        view_count: info.view_count,
        fileSize: info.filesize || info.filesize_approx || null
      };
    } catch (error) {
      retries++;
      if (retries > maxRetries) {
        throw new Error(`Failed to get video preview: ${error.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * retries));
    }
  }
};

const getStreamUrl = async (url, format) => {
  const videoUrl = getVideoUrl(url);
  const options = buildYtdlOptions(url, {
    format: format || 'best',
    dumpSingleJson: true,
  });

  const info = await ytdl(videoUrl, options);
  const hlsFormat = info.formats.find(
    f => f.ext === 'm3u8_native' || 
          f.protocol === 'm3u8_native' || 
          (f.url && f.url.includes('.m3u8'))
  );

  if (hlsFormat?.url) {
    return {
      url: hlsFormat.url,
      format: hlsFormat.format_id,
      duration: info.duration,
      title: info.title,
    };
  }

  if (format) {
    const chosen = info.formats.find(f => f.format_id === format);
    if (chosen?.url) {
      return {
        url: chosen.url,
        format: chosen.format_id,
        duration: info.duration,
        title: info.title,
      };
    }
  }

  const progressive = info.formats
    .filter(f => f.protocol === 'https' && f.vcodec !== 'none' && f.acodec !== 'none')
    .sort((a, b) => (b.filesize || 0) - (a.filesize || 0))[0];

  if (progressive?.url) {
    return {
      url: progressive.url,
      format: progressive.format_id,
      duration: info.duration,
      title: info.title,
    };
  }

  throw new Error('No suitable stream format found');
};

const startDownload = async (url, format) => {
  const id = uuidv4();
  const output = path.join(DOWNLOAD_DIR, `${id}.%(ext)s`);
  const videoUrl = getVideoUrl(url);

  const progressEmitter = new DownloadProgressEmitter();
  progressEmitters.set(id, progressEmitter);

  downloads.set(id, {
    id,
    url: videoUrl,
    format,
    status: 'downloading',
    progress: 0,
    filePath: null,
    error: null,
    startTime: Date.now()
  });

  (async () => {
    try {
      const options = buildYtdlOptions(url);
      const args = [videoUrl, '-o', output];

      if (format) args.push('-f', format);
      if (options.proxy) args.push('--proxy', options.proxy);
      if (options.userAgent) args.push('--user-agent', options.userAgent);
      if (options.referer) args.push('--referer', options.referer);
      if (options.addHeader) {
        options.addHeader.forEach(hdr => args.push('--add-header', hdr));
      }

      const ytdlProcess = ytdl.exec(args);

      ytdlProcess.stderr.on('data', (data) => {
        const line = data.toString();
        const progressMatch = line.match(/download\s+(\d+\.\d+)%/);
        if (progressMatch) {
          const progress = parseFloat(progressMatch[1]);
          const download = downloads.get(id);
          if (download) {
            download.progress = progress;
            progressEmitter.emit('progress', progress);
          }
        }
        
        // Log non-progress messages
        if (!progressMatch && !line.includes('[download] Destination')) {
          console.log(`[yt-dlp ${id}]: ${line.trim()}`);
        }
      });

      await ytdlProcess;

      const files = fs.readdirSync(DOWNLOAD_DIR);
      const outputFile = files.find(f => f.startsWith(id));

      if (outputFile) {
        const filePath = path.join(DOWNLOAD_DIR, outputFile);
        const stats = fs.statSync(filePath);
        const download = downloads.get(id);
        if (download) {
          download.status = 'completed';
          download.filePath = filePath;
          download.fileSize = stats.size;
          download.duration = Date.now() - download.startTime;
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
        download.duration = Date.now() - download.startTime;
      }
      progressEmitter.emit('error', error.message || 'Unknown error');
      console.error(`Download ${id} failed:`, error);
    } finally {
      // Clean up after 5 minutes
      setTimeout(() => {
        progressEmitters.delete(id);
        downloads.delete(id);
      }, 300000);
    }
  })();

  return id;
};

const setupProgressStream = (id, res) => {
  const progressEmitter = progressEmitters.get(id);
  if (!progressEmitter) return res.status(404).json({ error: 'Download not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flush !== 'function') res.flush = () => {};
  res.flushHeaders();

  const sendEvent = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    res.flush();
  };

  const download = downloads.get(id);
  if (download) sendEvent('init', { 
    progress: download.progress,
    status: download.status
  });

  const progressHandler = (progress) => sendEvent('progress', { progress });
  const completeHandler = (filePath) => {
    const fileName = path.basename(filePath);
    sendEvent('completed', { 
      downloadUrl: `/downloads/${fileName}`,
      fileName
    });
  };
  const errorHandler = (error) => sendEvent('error', { error });

  progressEmitter.on('progress', progressHandler);
  progressEmitter.on('completed', completeHandler);
  progressEmitter.on('error', errorHandler);

  res.on('close', () => {
    progressEmitter.off('progress', progressHandler);
    progressEmitter.off('completed', completeHandler);
    progressEmitter.off('error', errorHandler);
    res.end();
  });
};

const getDownloadStatus = (id) => {
  const status = downloads.get(id);
  if (!status) throw new Error('Download not found');
  return { ...status };
};

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

const streamDownload = async (url, format, res) => {
  const videoUrl = getVideoUrl(url);
  try {
    const options = buildYtdlOptions(url, {
      dumpSingleJson: true,
      format: format || 'best',
    });

    const info = await ytdl(videoUrl, options);
    const safeTitle = (info.title || 'video').replace(/[^\w\s]/gi, '');
    const extension = 'mp4';

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.${extension}"`);
    res.setHeader('X-Video-Title', encodeURIComponent(info.title || 'video'));
    res.setHeader('X-Video-Duration', info.duration || 0);

    const args = [
      videoUrl,
      '-f',
      format || 'best',
      '-o',
      '-',
      '--no-part',
      '--no-check-certificates',
      '--merge-output-format',
      'mp4',
      '--no-simulate',
      '--no-cache-dir'
    ];

    if (options.addHeader) {
      options.addHeader.forEach(hdr => args.push('--add-header', hdr));
    }
    if (options.userAgent) args.push('--user-agent', options.userAgent);
    if (options.proxy) args.push('--proxy', options.proxy);
    if (options.referer) args.push('--referer', options.referer);

    if (getPlatformConfig(videoUrl) === 'instagram' && process.env.INSTAGRAM_COOKIES) {
      args.push('--add-header', `cookie: ${process.env.INSTAGRAM_COOKIES}`);
    }

    const ytdlProc = spawn(ytdlPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Handle client disconnect
    let aborted = false;
    const cleanup = () => {
      if (!aborted) {
        aborted = true;
        if (!ytdlProc.killed) {
          ytdlProc.kill('SIGKILL');
        }
      }
    };

    res.on('close', cleanup);
    res.on('finish', cleanup);
    res.on('error', cleanup);

    // Pipe output to response
    ytdlProc.stdout.pipe(res);
    
    // Handle errors
    ytdlProc.stderr.on('data', (data) => {
      const message = data.toString();
      if (!aborted && !res.headersSent && message.includes('ERROR')) {
        console.error(`[yt-dlp ${videoUrl}]: ${message.trim()}`);
        res.status(500).end('Stream failed');
        cleanup();
      }
    });

    ytdlProc.on('error', (err) => {
      if (!aborted && !res.headersSent) {
        console.error(`yt-dlp spawn error [${videoUrl}]:`, err);
        res.status(500).end('Download failed');
      }
      cleanup();
    });

    ytdlProc.on('close', (code) => {
      if (code !== 0 && !aborted && !res.headersSent) {
        console.error(`yt-dlp exited with code ${code} for ${videoUrl}`);
        res.status(500).end('Download failed');
      }
      cleanup();
    });

    // Set timeout
    const timeout = setTimeout(() => {
      if (!aborted && !res.headersSent) {
        console.error(`Stream timeout for ${videoUrl}`);
        res.status(504).end('Download timeout');
      }
      cleanup();
    }, 120000); // 2 minutes

    // Clean up on finish
    res.on('finish', () => {
      clearTimeout(timeout);
      cleanup();
    });

  } catch (err) {
    if (!res.headersSent) {
      if (err.message.includes('login required') || err.message.includes('rate-limit reached')) {
        res.status(401).json({ error: 'Authentication required' });
      } else if (err.message.includes('Unsupported URL')) {
        res.status(400).json({ error: 'Unsupported URL' });
      } else {
        console.error(`Streaming error [${videoUrl}]:`, err);
        res.status(500).json({ error: err.message || 'Stream failed' });
      }
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
  streamDownload,
};
