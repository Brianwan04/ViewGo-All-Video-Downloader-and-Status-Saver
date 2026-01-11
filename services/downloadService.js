const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');
const ytdl = require('yt-dlp-exec');
const http = require('http');
const https = require('https');
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
    forceIpv4: false,
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
    referer: 'https://www.facebook.com/',
  },
  soundcloud: {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    referer: 'https://soundcloud.com/',
    extractorArgs: {
      soundcloud: {
        format: 'mp3',
      },
    },
  },
  twitter: {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    referer: 'https://twitter.com/',
    extractorArgs: {
      twitter: {
        skip_webpage: true,
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
const isXUrl = (url) => /(x\.com|twitter\.com)/i.test(url);
const isTikTokShort = (url) => /vm\.tiktok\.com/i.test(url);
const getVideoUrl = (input) => (typeof input === 'string' ? input : input.url);

// --- Redirect resolver for shortlinks (handles vm.tiktok etc) ---
function resolveRedirect(originalUrl, maxRedirects = 6, timeoutMs = 8000) {
  return new Promise((resolve) => {
    try {
      const normalized = originalUrl.startsWith('http') ? originalUrl : `https://${originalUrl}`;
      let redirects = 0;

      const doRequest = (u) => {
        if (redirects >= maxRedirects) return resolve(u);
        const useHttps = u.startsWith('https://');
        const client = useHttps ? https : http;
        const req = client.request(u, { method: 'HEAD', timeout: timeoutMs }, (res) => {
          const status = res.statusCode;
          if (status >= 300 && status < 400 && res.headers.location) {
            redirects++;
            const next = new URL(res.headers.location, u).toString();
            doRequest(next);
          } else {
            resolve(u);
          }
        });
        req.on('timeout', () => {
          req.destroy();
          resolve(normalized);
        });
        req.on('error', () => resolve(normalized));
        req.end();
      };

      doRequest(normalized);
    } catch (e) {
      resolve(originalUrl);
    }
  });
}

// --- Options builder (adds referer, headers, cookies, bearer) ---
const buildYtdlOptions = (input, extraOptions = {}) => {
  const config = typeof input === 'object' ? input.config || {} : {};
  const videoUrl = getVideoUrl(input);
  const platform = typeof input === 'object' ? input.platform || (isSoundCloudUrl(videoUrl) ? 'soundcloud' : 'default') : 'default';

  const baseOptions = {
    noCheckCertificates: true,
    noWarnings: true,
    ...PLATFORM_CONFIGS.default,
    ...(PLATFORM_CONFIGS[platform] || {}),
    ...config,
  };

  baseOptions.addHeader = baseOptions.addHeader || [];

  // referer/header for X/Twitter
  if (isXUrl(videoUrl)) {
    baseOptions.referer = baseOptions.referer || 'https://x.com';
    baseOptions.addHeader.push(`Referer: ${baseOptions.referer}`);
  } else if (isTikTokShort(videoUrl) || /tiktok\.com/i.test(videoUrl)) {
    baseOptions.referer = baseOptions.referer || 'https://www.tiktok.com/';
    baseOptions.addHeader.push(`Referer: ${baseOptions.referer}`);
  } else if (baseOptions.referer) {
    baseOptions.addHeader.push(`Referer: ${baseOptions.referer}`);
  }

  // cookie path env var (point to cookies file path)
  if (process.env.YTDLP_COOKIE_PATH && process.env.YTDLP_COOKIE_PATH.trim() !== '') {
    baseOptions.cookies = process.env.YTDLP_COOKIE_PATH;
  }

  // legacy support: INSTAGRAM_COOKIES environment -> header
  if (isInstagramUrl(videoUrl) && process.env.INSTAGRAM_COOKIES) {
    baseOptions.addHeader.push(`cookie: ${process.env.INSTAGRAM_COOKIES}`);
  }

  // If cookies passed as string, convert to addHeader
  if (baseOptions.cookies && typeof baseOptions.cookies === 'string') {
    baseOptions.addHeader.push(`cookie: ${baseOptions.cookies.trim()}`);
    delete baseOptions.cookies;
  }

  // Support bearer token for X download if provided
  if (process.env.YTDLP_AUTH_BEARER && process.env.YTDLP_AUTH_BEARER.trim() !== '') {
    baseOptions.addHeader.push(`Authorization: Bearer ${process.env.YTDLP_AUTH_BEARER.trim()}`);
  }

  if (baseOptions.proxy && baseOptions.proxy.trim() === '') {
    delete baseOptions.proxy;
  }

  return { ...baseOptions, ...extraOptions };
};

// --- filesize helpers (kept original logic) ---
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

  if (format.vcodec === 'none' && duration) {
    const defaultAudioBitrate = 128;
    return (defaultAudioBitrate * 1000 * duration) / 8;
  }

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

// --- getFormats: resolves redirects and returns progressive formats ---
const getFormats = async (url) => {
  try {
    const original = getVideoUrl(url);
    const resolved = await resolveRedirect(original);
    const options = buildYtdlOptions({ url: resolved }, {
      dumpSingleJson: true,
      preferFreeFormats: true,
      skipDownload: true,
    });

    const info = await ytdl(resolved, options);
    const duration = info.duration;

    let formats = isSoundCloudUrl(resolved)
      ? info.formats.filter((f) => f.acodec !== 'none' && f.vcodec === 'none')
      : info.formats.filter((f) => f.vcodec !== 'none' && f.acodec !== 'none');

    return formats.map((f) => {
      let filesize = calculateFileSize(f, duration);

      if (!filesize && (isFacebookUrl(resolved) || isInstagramUrl(resolved))) {
        filesize = getEstimatedSizeForAdaptive(info.formats, duration);
      }

      if (!filesize && duration) {
        const height = f.height || 720;
        const estimatedBitrate = isSoundCloudUrl(resolved) ? 128 : estimateBitrateByRes(height);
        filesize = (estimatedBitrate * 1000 * duration) / 8;
      }

      return {
        format_id: f.format_id,
        ext: f.ext || (isSoundCloudUrl(resolved) ? 'mp3' : 'mp4'),
        resolution: isSoundCloudUrl(resolved) ? (f.abr ? `${f.abr}kbps` : 'audio') : f.resolution || `${f.height}p` || 'unknown',
        format_note: f.format_note || (isSoundCloudUrl(resolved) ? 'audio' : 'video'),
        filesize: filesize || null,
      };
    });
  } catch (error) {
    throw new Error('Failed to get formats: ' + (error.message || error));
  }
};

// --- getVideoPreview (resolves shortlinks + retries) ---
const getVideoPreview = async (url) => {
  const maxRetries = 3;
  let retries = 0;
  const original = getVideoUrl(url);

  while (retries <= maxRetries) {
    try {
      const resolved = await resolveRedirect(original);
      const options = buildYtdlOptions({ url: resolved }, {
        dumpSingleJson: true,
        skipDownload: true,
      });

      const info = await ytdl(resolved, options);

      let fileSize = info.filesize || info.filesize_approx;

      if (!fileSize) {
        const bestFormat = isSoundCloudUrl(resolved)
          ? info.formats.filter((f) => f.acodec !== 'none' && f.vcodec === 'none').sort((a, b) => (b.abr || 0) - (a.abr || 0))[0]
          : getBestFormatForSizeCalculation(info.formats);

        if (bestFormat) {
          fileSize = calculateFileSize(bestFormat, info.duration);
        }
      }

      if (!fileSize && (isFacebookUrl(resolved) || isInstagramUrl(resolved))) {
        fileSize = getEstimatedSizeForAdaptive(info.formats, info.duration);
      }

      if (!fileSize && info.duration) {
        const defaultBitrate = isSoundCloudUrl(resolved) ? 128 : estimateBitrateByRes(720);
        fileSize = (defaultBitrate * 1000 * info.duration) / 8;
      }

      return {
        id: info.id || resolved,
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
      // give X/Twitter cookie retry a chance if env set
      if (retries <= maxRetries) await new Promise((r) => setTimeout(r, 1000 * retries));
      if (retries > maxRetries) {
        throw new Error('Failed to get video preview: ' + (error.message || error));
      }
    }
  }
};

// --- getStreamUrl resolves redirect and picks HLS or direct url ---
const getStreamUrl = async (url, format) => {
  const original = getVideoUrl(url);
  const resolved = await resolveRedirect(original);
  const options = buildYtdlOptions({ url: resolved }, {
    format: format || (isSoundCloudUrl(resolved) ? 'bestaudio[ext=mp3]' : 'best'),
    dumpSingleJson: true,
    skipDownload: true,
  });

  const info = await ytdl(resolved, options);

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

  const preferred = isSoundCloudUrl(resolved)
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

// --- startDownload: improved handling for adaptive downloads (uses merge flags) ---
const startDownload = async (url, format) => {
  const id = uuidv4();
  const output = path.join(DOWNLOAD_DIR, `${id}.%(ext)s`);
  const original = getVideoUrl(url);
  const resolved = await resolveRedirect(original);

  const progressEmitter = new DownloadProgressEmitter();
  progressEmitters.set(id, progressEmitter);

  downloads.set(id, {
    id,
    url: resolved,
    format,
    status: 'downloading',
    progress: 0,
    filePath: null,
    error: null,
  });

  (async () => {
    try {
      // Inspect formats to decide flags for adaptive
      const infoOptions = buildYtdlOptions({ url: resolved }, { dumpSingleJson: true, skipDownload: true });
      let info;
      try {
        info = await ytdl(resolved, infoOptions);
      } catch (e) {
        // proceed anyway; yt-dlp may still succeed when doing full download
        info = null;
      }

      const isAdaptive = info && info.formats && info.formats.some((f) => f.vcodec !== 'none' && f.acodec === 'none') &&
                         info.formats.some((f) => f.vcodec === 'none' && f.acodec !== 'none');

      const options = buildYtdlOptions({ url: resolved });
      const args = [resolved, '-o', output];

      if (format) {
        args.push('-f', format);
      } else if (isSoundCloudUrl(resolved)) {
        args.push('-f', 'bestaudio[ext=mp3]');
      }

      // For adaptive downloads prefer ffmpeg merge
      if (isAdaptive) {
        args.push('--hls-prefer-ffmpeg', '--merge-output-format', 'mp4', '--no-part');
      }

      if (options.cookies) args.push('--cookies', options.cookies);
      if (options.proxy) args.push('--proxy', options.proxy);
      if (options.userAgent) args.push('--user-agent', options.userAgent);
      if (options.referer) args.push('--referer', options.referer);
      if (options.addHeader) {
        options.addHeader.forEach((hdr) => args.push('--add-header', hdr));
      }

      if (isSoundCloudUrl(resolved)) {
        args.push('--merge-output-format', 'mp3');
      }

      const ytdlProcess = ytdl.exec(args);

      ytdlProcess.stderr.on('data', (data) => {
        const line = data.toString();
        const match = line.match(/download\s+(\d+\.\d+)%/i);
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

// --- SSE progress setup (unchanged) ---
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

// --- streamDownload: progressive -> pipe stdout, adaptive -> temp file + stream merged output ---
const streamDownload = async (url, format, res) => {
  const original = getVideoUrl(url);
  const resolved = await resolveRedirect(original);

  // Generate a stream id
  const streamId = uuidv4();

  downloads.set(streamId, {
    id: streamId,
    url: resolved,
    format,
    status: 'streaming',
    progress: 0,
    filePath: null,
    error: null,
    metadata: null,
  });

  try {
    // Quick metadata/info check to decide adaptive vs progressive
    const infoOptions = buildYtdlOptions({ url: resolved }, { dumpSingleJson: true, skipDownload: true });
    let info;
    try {
      info = await ytdl(resolved, infoOptions);
    } catch (e) {
      info = null; // proceed; we'll try streaming anyway
    }

    const hasAdaptive = info && info.formats &&
      info.formats.some((f) => f.vcodec !== 'none' && f.acodec === 'none') &&
      info.formats.some((f) => f.vcodec === 'none' && f.acodec !== 'none');

    const fallbackName = `download-${streamId}`;
    const extension = isSoundCloudUrl(resolved) ? 'mp3' : 'mp4';

    // Send early headers
    res.setHeader('Content-Disposition', `attachment; filename="${fallbackName}.${extension}"`);
    res.setHeader('X-Stream-Id', streamId);
    res.setHeader('Cache-Control', 'no-cache');
    if (typeof res.setTimeout === 'function') res.setTimeout(0);

    // Fire-and-forget metadata fetch (if not already available)
    (async () => {
      try {
        if (!info) {
          const metaOptions = buildYtdlOptions({ url: resolved }, { dumpSingleJson: true, skipDownload: true });
          info = await ytdl(resolved, metaOptions);
        }
        const entry = downloads.get(streamId);
        if (entry) {
          entry.metadata = {
            id: info.id || resolved,
            title: info.title || null,
            thumbnail: info.thumbnail || null,
            duration: info.duration || null,
            uploader: info.uploader || null,
            view_count: info.view_count || null,
            filesize: info.filesize || info.filesize_approx || null,
            extractor: info.extractor_key || null,
            formats: info.formats ? info.formats.map((f) => ({ format_id: f.format_id, ext: f.ext, width: f.width, height: f.height, abr: f.abr })) : null,
          };
        }
      } catch (metaErr) {
        const entry = downloads.get(streamId);
        if (entry) entry.metadata = { error: metaErr && metaErr.message };
      }
    })();

    // If not adaptive OR audio-only (SoundCloud) => stream directly to client
    if (!hasAdaptive || isSoundCloudUrl(resolved)) {
      res.setHeader('Content-Type', isSoundCloudUrl(resolved) ? 'audio/mpeg' : 'video/mp4');

      const args = [
        resolved,
        '-f',
        format || (isSoundCloudUrl(resolved) ? 'bestaudio[ext=mp3]' : 'best'),
        '-o',
        '-',
        '--no-part',
        '--no-check-certificates',
        '--newline',
      ];

      const options = buildYtdlOptions({ url: resolved });
      if (options.addHeader) options.addHeader.forEach((h) => args.push('--add-header', h));
      if (options.userAgent) args.push('--user-agent', options.userAgent);
      if (options.proxy) args.push('--proxy', options.proxy);
      if (options.referer) args.push('--referer', options.referer);

      const ytdlProc = spawn(ytdlPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      // Pipe stdout directly
      ytdlProc.stdout.pipe(res);

      ytdlProc.stderr.on('data', (data) => {
        console.error('[yt-dlp stderr]', data.toString());
      });

      ytdlProc.on('close', (code) => {
        const entry = downloads.get(streamId);
        if (code === 0) {
          if (entry) entry.status = 'completed';
          try {
            if (!res.writableEnded) res.end();
          } catch {}
        } else {
          if (entry) {
            entry.status = 'error';
            entry.error = `yt-dlp exit code ${code}`;
          }
          if (!res.headersSent) res.status(500).end('Download failed');
          else try { if (!res.writableEnded) res.end(); } catch {}
        }
      });

      res.on('close', () => {
        try { if (ytdlProc && !ytdlProc.killed) ytdlProc.kill('SIGTERM'); } catch {}
      });
    } else {
      // Adaptive: download to temp file, let yt-dlp/ffmpeg merge, then stream merged file
      const tmpFile = path.join(os.tmpdir(), `${streamId}.${extension}`);
      const args = [
        resolved,
        '-f',
        format || 'bestvideo+bestaudio',
        '-o',
        tmpFile,
        '--hls-prefer-ffmpeg',
        '--merge-output-format',
        extension,
        '--no-part',
        '--no-check-certificates',
        '--retries',
        '3',
        '--fragment-retries',
        '3',
        '--newline',
      ];

      const options = buildYtdlOptions({ url: resolved });
      if (options.addHeader) options.addHeader.forEach((h) => args.push('--add-header', h));
      if (options.userAgent) args.push('--user-agent', options.userAgent);
      if (options.proxy) args.push('--proxy', options.proxy);
      if (options.referer) args.push('--referer', options.referer);
      if (options.cookies) args.push('--cookies', options.cookies);

      const ytdlProc = spawn(ytdlPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      ytdlProc.stderr.on('data', (data) => {
        // Optional: parse progress lines and emit to progressEmitters if desired
        console.error('[yt-dlp stderr]', data.toString());
      });

      ytdlProc.on('close', (code) => {
        const entry = downloads.get(streamId);
        if (code === 0 && fs.existsSync(tmpFile)) {
          if (entry) entry.status = 'completed';
          // Stream the merged file to client
          res.setHeader('Content-Type', 'video/mp4');
          const fileStream = fs.createReadStream(tmpFile);
          fileStream.pipe(res);
          fileStream.on('close', () => {
            try { fs.unlinkSync(tmpFile); } catch (e) {}
            if (!res.writableEnded) res.end();
          });
          fileStream.on('error', (err) => {
            if (!res.headersSent) res.status(500).end('Failed to stream merged file');
            else try { if (!res.writableEnded) res.end(); } catch (e) {}
            if (fs.existsSync(tmpFile)) try { fs.unlinkSync(tmpFile); } catch (e) {}
            if (entry) { entry.status = 'error'; entry.error = err.message; }
          });
        } else {
          if (entry) {
            entry.status = 'error';
            entry.error = `yt-dlp exit code ${code}`;
          }
          if (!res.headersSent) res.status(500).end('Download failed');
          else try { if (!res.writableEnded) res.end(); } catch (e) {}
          try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (e) {}
        }
      });

      res.on('close', () => {
        try { if (!ytdlProc.killed) ytdlProc.kill('SIGTERM'); } catch {}
      });
    }
  } catch (err) {
    console.error('Streaming error:', err);
    const entry = downloads.get(streamId);
    if (entry) {
      entry.status = 'error';
      entry.error = err.message;
    }
    if (!res.headersSent) {
      if (err.message && (err.message.includes('login required') || err.message.includes('rate-limit reached'))) {
        res.status(401).json({
          error: isSoundCloudUrl(getVideoUrl(url)) ? 'SoundCloud authentication may be required' : 'Authentication required',
        });
      } else {
        res.status(500).json({ error: err.message || 'Stream failed' });
      }
    } else {
      try { if (!res.writableEnded) res.end(); } catch (e) {}
    }
  }

  return streamId;
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
