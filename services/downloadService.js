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
    forceIpv4: true,
    proxy: process.env.INSTAGRAM_PROXY || '',
  },
  facebook: {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    extractorArgs: {
      facebook: {
        skip_auth: true,
        skip_web_fallback: true,
      },
    },
  },
  default: {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    referer: 'https://www.google.com/',
  },
};

const isInstagramUrl = (url) => {
  return /instagram\.com/i.test(url);
};

const isFacebookUrl = (url) => {
  return /facebook\.com|fb\.watch/i.test(url);
};

const getVideoUrl = (input) => {
  return typeof input === 'string' ? input : input.url;
};

const buildYtdlOptions = (input, extraOptions = {}) => {
  const config = typeof input === 'object' ? input.config || {} : {};
  const platform = typeof input === 'object' ? input.platform || 'default' : 'default';
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

// --- smarter file size calc that can pair video+audio streams ---
const calculateFileSize = (format, duration) => {
  if (!format) return null;

  // exact size if present
  if (format.filesize) return format.filesize;
  if (format.filesize_approx) return format.filesize_approx;

  // if format has combined bitrate or tbr
  let totalBitrate = format.tbr || format.total_bitrate || 0;
  const videoBitrate = format.vbr || format.vbitrate || 0;
  const audioBitrate = format.abr || format.abitrate || 0;

  if (!totalBitrate) {
    totalBitrate = videoBitrate + audioBitrate;
  }

  if (totalBitrate && duration) {
    // bitrate is kbps commonly: convert to bytes
    return Math.round((totalBitrate * 1000 * duration) / 8);
  }

  return null;
};

// --- choose best candidates; allow pairing audio+video if no progressive ---
const getBestFormatForSizeCalculation = (formats, duration) => {
  if (!Array.isArray(formats) || formats.length === 0) return null;

  // 1) Prefer a progressive (both audio+video) with filesize or highest resolution
  const progressive = formats.filter(f => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none');
  if (progressive.length > 0) {
    // prefer one with filesize first, then highest resolution
    const byFilesize = progressive.filter(f => f.filesize || f.filesize_approx).sort((a, b) => (b.filesize || b.filesize_approx || 0) - (a.filesize || a.filesize_approx || 0));
    if (byFilesize.length) return byFilesize[0];
    return progressive.sort((a, b) => (b.width || 0) - (a.width || 0) || (b.height || 0) - (a.height || 0))[0];
  }

  // 2) No progressive: choose best video-only + best audio-only and return a synthetic "paired" object
  const videoOnly = formats.filter(f => f.vcodec && f.vcodec !== 'none' && (!f.acodec || f.acodec === 'none'));
  const audioOnly = formats.filter(f => (!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none');

  // pick highest resolution video and highest bitrate audio
  const bestVideo = videoOnly.sort((a, b) => (b.width || 0) - (a.width || 0) || (b.height || 0) - (a.height || 0))[0];
  const bestAudio = audioOnly.sort((a, b) => (b.abr || b.abitrate || 0) - (a.abr || a.abitrate || 0))[0];

  if (bestVideo || bestAudio) {
    // construct synthetic format for calculating size:
    const synthetic = {
      format_id: `${bestVideo?.format_id || 'videoonly'}+${bestAudio?.format_id || 'audioonly'}`,
      ext: (bestVideo && bestVideo.ext) || (bestAudio && bestAudio.ext) || 'mp4',
      vbr: bestVideo ? (bestVideo.tbr || bestVideo.vbr || bestVideo.vbitrate || 0) : 0,
      abr: bestAudio ? (bestAudio.abr || bestAudio.abitrate || 0) : 0,
      tbr: (bestVideo ? (bestVideo.tbr || bestVideo.vbr || 0) : 0) + (bestAudio ? (bestAudio.abr || bestAudio.abitrate || 0) : 0),
      // provide hints
      paired: { video: bestVideo, audio: bestAudio }
    };
    // return synthetic format; caller should pass duration into calculateFileSize
    return synthetic;
  }

  // 3) fallback - return the top format by any filesize / known bitrate
  return formats.sort((a, b) => (b.filesize || b.filesize_approx || b.tbr || 0) - (a.filesize || a.filesize_approx || a.tbr || 0))[0];
};

// --- getFormats --- (replaces original - no aggressive filter)
const getFormats = async (url) => {
  try {
    const videoUrl = getVideoUrl(url);
    const options = buildYtdlOptions(url, {
      dumpSingleJson: true,
      preferFreeFormats: true,
    });

    const info = await ytdl(videoUrl, options);
    const duration = info.duration || 0;
    const formats = info.formats || [];

    // build a list of entries with best-effort filesize calculation
    const results = formats.map((f) => {
      // keep raw as-is but compute filesize if missing
      const size = f.filesize || f.filesize_approx || calculateFileSize(f, duration);
      return {
        format_id: f.format_id,
        ext: f.ext,
        resolution: f.format_note || (f.height ? `${f.height}p` : 'unknown'),
        format_note: f.format_note,
        hasAudio: !(f.acodec === 'none' || !f.acodec),
        hasVideo: !(f.vcodec === 'none' || !f.vcodec),
        filesize: size || null,
        raw: f
      };
    });

    // If none of the above have filesize, attempt pairing to get a single estimate
    const anyWithFile = results.find(r => r.filesize);
    if (!anyWithFile) {
      const best = getBestFormatForSizeCalculation(formats, duration);
      const size = calculateFileSize(best, duration);
      // return a single synthetic result if no per-format sizes were available
      return [{
        format_id: best.format_id,
        ext: best.ext,
        resolution: best.height ? `${best.height}p` : 'unknown',
        format_note: 'paired-estimate',
        filesize: size || null,
        raw: best
      }];
    }

    // otherwise return all results (consumer can pick)
    return results;
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
      
      // For all platforms, try to get the best format for size calculation
      let fileSize = info.filesize || info.filesize_approx;
      if (!fileSize) {
        const bestFormat = getBestFormatForSizeCalculation(info.formats);
        if (bestFormat) {
          fileSize = calculateFileSize(bestFormat, info.duration);
        }
      }

      return {
        id: info.id || videoUrl,
        title: info.title,
        thumbnail: info.thumbnail,
        duration: info.duration,
        platform: info.extractor_key,
        uploader: info.uploader,
        view_count: info.view_count,
        fileSize: fileSize || null
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
    format: format || 'best',
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

  const progressive = info.formats
    .filter((f) => f.protocol === 'https' && f.vcodec !== 'none' && f.acodec !== 'none')
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
  });

  (async () => {
    try {
      const options = buildYtdlOptions(url);
      const args = [videoUrl, '-o', output];

      if (format) args.push('-f', format);
      if (options.cookies) args.push('--cookies', options.cookies);
      if (options.proxy) args.push('--proxy', options.proxy);
      if (options.userAgent) args.push('--user-agent', options.userAgent);
      if (options.referer) args.push('--referer', options.referer);
      if (options.addHeader) {
        options.addHeader.forEach((hdr) => args.push('--add-header', hdr));
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
      format: format || 'best',
    });

    const info = await ytdl(videoUrl, options);
    const safeTitle = (info.title || 'video').replace(/[^\w\s]/gi, '');
    const extension = 'mp4';

    const fileSize = info.filesize || info.filesize_approx;

  /*if (fileSize) {
    res.setHeader('Content-Length', fileSize);
  }
*/

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.${extension}"`);

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
    ];

    if (options.addHeader) {
      options.addHeader.forEach((hdr) => args.push('--add-header', hdr));
    }
    if (options.userAgent) args.push('--user-agent', options.userAgent);
    if (options.proxy) args.push('--proxy', options.proxy);
    if (options.referer) args.push('--referer', options.referer);

    if (isInstagramUrl(url) && process.env.INSTAGRAM_COOKIES) {
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
    if (err.message.includes('login required') || 
        err.message.includes('rate-limit reached')) {
      res.status(401).json({ 
        error: 'Instagram authentication required'
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
