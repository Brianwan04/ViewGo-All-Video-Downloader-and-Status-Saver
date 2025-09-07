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
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    referer: 'https://www.youtube.com/',
  },
  instagram: {
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    referer: 'https://www.instagram.com/',
    forceIpv4: false, // Adjusted for better compatibility
  },
  facebook: {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    extractorArgs: {
      facebook: {
        skip_auth: false,
        skip_web_fallback: true,
      },
    },
  },
  soundcloud: {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    referer: 'https://soundcloud.com/',
    extractorArgs: {
      soundcloud: {
        format: 'mp3', // Prefer MP3 for audio
      },
    },
  },
  default: {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    referer: 'https://www.google.com/',
  },
};

// URL detection functions
const isInstagramUrl = (url) => /instagram\.com/i.test(url);
const isFacebookUrl = (url) => /facebook\.com|fb\.watch/i.test(url);
const isSoundCloudUrl = (url) => /soundcloud\.com/i.test(url);
const getVideoUrl = (input) => (typeof input === 'string' ? input : input.url);

const buildYtdlOptions = (input, extraOptions = {}) => {
  const config = typeof input === 'object' ? input.config || {} : {};
  const platform = typeof input === 'object' ? input.platform || (isSoundCloudUrl(getVideoUrl(input)) ? 'soundcloud' : 'default') : 'default';
  const videoUrl = getVideoUrl(input);

  const baseOptions = {
    noCheckCertificates: true,
    noWarnings: true,
    ...PLATFORM_CONFIGS.default,
    ...(PLATFORM_CONFIGS[platform] || {}),
    ...config,
  };

  if (isInstagramUrl(videoUrl)) {
    if (process.env.INSTAGRAM_COOKIES) {
      baseOptions.addHeader = baseOptions.addHeader || [];
      baseOptions.addHeader.push(`cookie: ${process.env.INSTAGRAM_COOKIES}`);
    }
    if (process.env.INSTAGRAM_PROXY) {
      baseOptions.proxy = process.env.INSTAGRAM_PROXY;
    }
  }

  if (baseOptions.cookies && baseOptions.cookies.trim() !== '') {
    baseOptions.addHeader = [`cookie: ${baseOptions.cookies.trim()}`];
    delete baseOptions.cookies;
  }

  if (baseOptions.proxy && baseOptions.proxy.trim() === '') {
    delete baseOptions.proxy;
  }

  return { ...baseOptions, ...extraOptions };
};

// Updated calculateFileSize for audio support
const calculateFileSize = (format, duration) => {
  if (format.filesize) return format.filesize;
  if (format.filesize_approx) return format.filesize_approx;

  let totalBitrate = format.tbr || (format.abr || format.abitrate || 0);
  if (format.vcodec !== 'none') {
    totalBitrate += format.vbr || format.vbitrate || 0;
  }

  if (totalBitrate && duration) {
    return (totalBitrate * 1000 * duration) / 8;
  }

  // Fallback for audio-only (e.g., SoundCloud)
  if (format.vcodec === 'none' && duration) {
    const defaultAudioBitrate = 128; // Default to 128kbps for audio
    return (defaultAudioBitrate * 1000 * duration) / 8;
  }

  // Fallback for video based on resolution
  const height = format.height || 720;
  const estimatedBitrate = estimateBitrateByRes(height);
  if (estimatedBitrate && duration) {
    return (estimatedBitrate * 1000 * duration) / 8;
  }

  return null;
};

const estimateBitrateByRes = (height) => {
  if (height >= 1080) return 5000;
  if (height >= 720) return 2500;
  if (height >= 480) return 1000;
  return 500;
};

const getEstimatedSizeForAdaptive = (formats, duration) => {
  const bestVideo = formats
    .filter((f) => f.vcodec !== 'none' && f.acodec === 'none')
    .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
  const bestAudio = formats
    .filter((f) => f.acodec !== 'none' && f.vcodec === 'none')
    .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

  const videoSize = bestVideo ? calculateFileSize(bestVideo, duration) : null;
  const audioSize = bestAudio ? calculateFileSize(bestAudio, duration) : null;

  if (videoSize && audioSize) {
    return videoSize + audioSize;
  }

  if (duration) {
    const defaultBitrate = estimateBitrateByRes(bestVideo?.height || 720);
    return (defaultBitrate * 1000 * duration) / 8;
  }

  return null;
};

const getBestFormatForSizeCalculation = (formats) => {
  const progressive = formats.filter(
    (f) => f.protocol === 'https' && f.vcodec !== 'none' && f.acodec !== 'none'
  );

  if (progressive.length > 0) {
    return progressive.sort(
      (a, b) => (b.width || 0) - (a.width || 0) || (b.height || 0) - (a.height || 0)
    )[0];
  }

  return formats.sort(
    (a, b) => (b.width || 0) - (a.width || 0) || (b.height || 0) - (a.height || 0)
  )[0];
};

const getFormats = async (url) => {
  try {
    const videoUrl = getVideoUrl(url);
    const options = buildYtdlOptions(url, {
      dumpSingleJson: true,
      preferFreeFormats: true,
    });

    const info = await ytdl(videoUrl, options);
    const duration = info.duration;

    let formats = isSoundCloudUrl(videoUrl)
      ? info.formats.filter((f) => f.acodec !== 'none' && f.vcodec === 'none') // Audio-only for SoundCloud
      : info.formats.filter((f) => f.vcodec !== 'none' && f.acodec !== 'none'); // Progressive for others

    return formats.map((f) => {
      let filesize = calculateFileSize(f, duration);

      if (!filesize && (isFacebookUrl(videoUrl) || isInstagramUrl(videoUrl))) {
        filesize = getEstimatedSizeForAdaptive(info.formats, duration);
      }

      if (!filesize && duration) {
        const height = f.height || 720;
        const estimatedBitrate = isSoundCloudUrl(videoUrl) ? 128 : estimateBitrateByRes(height);
        filesize = (estimatedBitrate * 1000 * duration) / 8;
      }

      return {
        format_id: f.format_id,
        ext: f.ext || (isSoundCloudUrl(videoUrl) ? 'mp3' : 'mp4'),
        resolution: isSoundCloudUrl(videoUrl) ? f.abr ? `${f.abr}kbps` : 'audio' : f.resolution || `${f.height}p` || 'unknown',
        format_note: f.format_note || (isSoundCloudUrl(videoUrl) ? 'audio' : 'video'),
        filesize: filesize || null,
      };
    });
  } catch (error) {
    throw new Error('Failed to get formats: ' + error.message);
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
      let fileSize = info.filesize || info.filesize_approx;

      if (!fileSize) {
        const bestFormat = isSoundCloudUrl(videoUrl)
          ? info.formats.filter((f) => f.acodec !== 'none' && f.vcodec === 'none').sort((a, b) => (b.abr || 0) - (a.abr || 0))[0]
          : getBestFormatForSizeCalculation(info.formats);
        if (bestFormat) {
          fileSize = calculateFileSize(bestFormat, info.duration);
        }
      }

      if (!fileSize && (isFacebookUrl(videoUrl) || isInstagramUrl(videoUrl))) {
        fileSize = getEstimatedSizeForAdaptive(info.formats, info.duration);
      }

      if (!fileSize && info.duration) {
        const defaultBitrate = isSoundCloudUrl(videoUrl) ? 128 : estimateBitrateByRes(720);
        fileSize = (defaultBitrate * 1000 * info.duration) / 8;
      }

      return {
        id: info.id || videoUrl,
        title: info.title || 'Untitled',
        thumbnail: info.thumbnail || null,
        duration: info.duration,
        platform: info.extractor_key,
        uploader: info.uploader || 'Unknown',
        view_count: info.view_count || null,
        fileSize: fileSize || null,
      };
    } catch (error) {
      retries++;
      if (retries > maxRetries) {
        throw new Error('Failed to get video preview: ' + error.message);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * retries));
    }
  }
};

const getStreamUrl = async (url, format) => {
  const videoUrl = getVideoUrl(url);
  const options = buildYtdlOptions(url, {
    format: format || (isSoundCloudUrl(videoUrl) ? 'bestaudio[ext=mp3]' : 'best'),
    dumpSingleJson: true,
  });

  const info = await ytdl(videoUrl, options);

  const hlsFormat = info.formats.find(
    (f) =>
      f.ext === 'm3u8_native' ||
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
    const chosen = info.formats.find((f) => f.format_id === format);
    if (chosen?.url) {
      return {
        url: chosen.url,
        format: chosen.format_id,
        duration: info.duration,
        title: info.title,
      };
    }
  }

  const preferred = isSoundCloudUrl(videoUrl)
    ? info.formats.filter((f) => f.acodec !== 'none' && f.vcodec === 'none').sort((a, b) => (b.abr || 0) - (a.abr || 0))[0]
    : info.formats.filter((f) => f.protocol === 'https' && f.vcodec !== 'none' && f.acodec !== 'none').sort((a, b) => (b.filesize || 0) - (a.filesize || 0))[0];

  if (preferred?.url) {
    return {
      url: preferred.url,
      format: preferred.format_id,
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
  });

  (async () => {
    try {
      const options = buildYtdlOptions(url);
      const args = [videoUrl, '-o', output];

      if (format) {
        args.push('-f', format);
      } else if (isSoundCloudUrl(videoUrl)) {
        args.push('-f', 'bestaudio[ext=mp3]');
      }

      if (options.cookies) args.push('--cookies', options.cookies);
      if (options.proxy) args.push('--proxy', options.proxy);
      if (options.userAgent) args.push('--user-agent', options.userAgent);
      if (options.referer) args.push('--referer', options.referer);
      if (options.addHeader) {
        options.addHeader.forEach((hdr) => args.push('--add-header', hdr));
      }

      if (isSoundCloudUrl(videoUrl)) {
        args.push('--merge-output-format', 'mp3');
      }

      const ytdlProcess = ytdl.exec(args);

      ytdlProcess.stderr.on('data', (data) => {
        const line = data.toString();
        const match = line.match(/download\s+(\d+\.\d+)%/);
        if (match) {
          const progress = parseFloat(match[1]);
          const download = downloads.get(id);
          if (download) {
            download.progress = progress;
            progressEmitter.emit('progress', progress);
          }
        }
      });

      await ytdlProcess;

      const files = fs.readdirSync(DOWNLOAD_DIR);
      const outputFile = files.find((f) => f.startsWith(id));

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
      progressEmitter.emit('error', error.message || 'Unknown error');
    }
  })();

  return id;
};

const setupProgressStream = (id, res) => {
  const progressEmitter = progressEmitters.get(id);
  if (!progressEmitter) return res.status(404).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flush !== 'function') res.flush = () => {};
  res.flushHeaders();

  const sendEvent = (event, data) => {
    if (res.writableEnded || !res.writable) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    res.flush();
  };

  const download = downloads.get(id);
  if (download) sendEvent('progress', { progress: download.progress });

  progressEmitter.on('progress', (progress) => sendEvent('progress', { progress }));
  progressEmitter.on('completed', (filePath) => {
    sendEvent('completed', { downloadUrl: `/downloads/${path.basename(filePath)}` });
  });
  progressEmitter.on('error', (error) => {
    sendEvent('error', { error });
  });

  res.on('close', () => {
    progressEmitter.removeAllListeners();
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
      format: format || (isSoundCloudUrl(videoUrl) ? 'bestaudio[ext=mp3]' : 'best'),
    });

    const info = await ytdl(videoUrl, options);
    const safeTitle = (info.title || 'audio').replace(/[^\w\s]/gi, '');
    const extension = isSoundCloudUrl(videoUrl) ? 'mp3' : 'mp4';

    const fileSize = info.filesize || info.filesize_approx;

    /*if (fileSize) {
      res.setHeader('Content-Length', fileSize);
    }*/

    res.setHeader('Content-Type', isSoundCloudUrl(videoUrl) ? 'audio/mpeg' : 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.${extension}"`);

    const args = [
      videoUrl,
      '-f',
      format || (isSoundCloudUrl(videoUrl) ? 'bestaudio[ext=mp3]' : 'best'),
      '-o',
      '-',
      '--no-part',
      '--no-check-certificates',
      '--merge-output-format',
      isSoundCloudUrl(videoUrl) ? 'mp3' : 'mp4',
    ];

    if (options.addHeader) {
      options.addHeader.forEach((hdr) => args.push('--add-header', hdr));
    }
    if (options.userAgent) args.push('--user-agent', options.userAgent);
    if (options.proxy) args.push('--proxy', options.proxy);
    if (options.referer) args.push('--referer', options.referer);

    if (isInstagramUrl(videoUrl) && process.env.INSTAGRAM_COOKIES) {
      args.push('--add-header', `cookie: ${process.env.INSTAGRAM_COOKIES}`);
    }

    const ytdlProc = spawn(ytdlPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    ytdlProc.stdout.pipe(res);
    ytdlProc.stderr.on('data', (data) => {
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
    if (err.message.includes('login required') || err.message.includes('rate-limit reached')) {
      res.status(401).json({
        error: isSoundCloudUrl(videoUrl) ? 'SoundCloud authentication may be required' : 'Instagram authentication required',
      });
    } else {
      console.error('Streaming error:', err);
      if (!res.headersSent) {
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
