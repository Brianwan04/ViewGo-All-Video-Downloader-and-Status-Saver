// services/ytdlp-manager.js
// CommonJS drop-in replacement for your existing module.
// Replace your current module contents with this file.

const path = require('path');
const fs = require('fs');
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
  default: {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    referer: 'https://www.google.com/',
  },
};

const isInstagramUrl = (url) => /instagram\.com/i.test(url);
const isFacebookUrl = (url) => /facebook\.com|fb\.watch/i.test(url);
const isSoundCloudUrl = (url) => /soundcloud\.com/i.test(url);
const isTikTokShort = (url) => /vm\.tiktok\.com/i.test(url);
const isXUrl = (url) => /(x\.com|twitter\.com)/i.test(url);
const getVideoUrl = (input) => (typeof input === 'string' ? input : input.url);

// --- Redirect resolver (no extra deps) ---
function resolveRedirect(originalUrl, maxRedirects = 5, timeoutMs = 8000) {
  return new Promise((resolve) => {
    try {
      let redirects = 0;
      const urlObj = new URL(originalUrl.startsWith('http') ? originalUrl : `https://${originalUrl}`);

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
          resolve(originalUrl);
        });
        req.on('error', () => resolve(originalUrl));
        req.end();
      };

      doRequest(urlObj.toString());
    } catch (e) {
      resolve(originalUrl);
    }
  });
}

// --- Options builder (adds Bearer if provided) ---
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

  // Add referer / headers for X / TikTok shortlinks
  baseOptions.addHeader = baseOptions.addHeader || [];
  if (isXUrl(videoUrl)) {
    baseOptions.referer = baseOptions.referer || 'https://x.com';
    baseOptions.addHeader.push(`Referer: ${baseOptions.referer}`);
  } else if (/tiktok\.com/i.test(videoUrl)) {
    baseOptions.referer = baseOptions.referer || 'https://www.tiktok.com/';
    baseOptions.addHeader.push(`Referer: ${baseOptions.referer}`);
  } else if (baseOptions.referer) {
    baseOptions.addHeader.push(`Referer: ${baseOptions.referer}`);
  }

  // Add cookie env var if present
  if (process.env.YTDLP_COOKIE_PATH && process.env.YTDLP_COOKIE_PATH.trim() !== '') {
    baseOptions.cookies = process.env.YTDLP_COOKIE_PATH;
  } else if (baseOptions.cookies && baseOptions.cookies.trim() !== '') {
    // keep existing
  }

  // If INSTAGRAM_COOKIES env var is present, pass it as header (legacy support)
  if (isInstagramUrl(videoUrl) && process.env.INSTAGRAM_COOKIES) {
    baseOptions.addHeader.push(`cookie: ${process.env.INSTAGRAM_COOKIES}`);
  }

  // If cookies set as string, convert to addHeader cookie
  if (baseOptions.cookies && typeof baseOptions.cookies === 'string') {
    baseOptions.addHeader.push(`cookie: ${baseOptions.cookies.trim()}`);
    delete baseOptions.cookies;
  }

  // Authorization Bearer support (for X/Twitter) - set via env YTDLP_AUTH_BEARER
  if (process.env.YTDLP_AUTH_BEARER && process.env.YTDLP_AUTH_BEARER.trim() !== '') {
    baseOptions.addHeader.push(`Authorization: Bearer ${process.env.YTDLP_AUTH_BEARER.trim()}`);
  }

  if (baseOptions.proxy && baseOptions.proxy.trim() === '') {
    delete baseOptions.proxy;
  }

  // Merge extra options (dumpSingleJson etc)
  return { ...baseOptions, ...extraOptions };
};

// --- filesize helpers (kept your logic) ---
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

// --- Helper: detect 403 in yt-dlp error string ---
const is403Error = (err) => {
  const msg = (err && err.message) ? err.message.toString().toLowerCase() : String(err).toLowerCase();
  return msg.includes('http error 403') || msg.includes('failed to download m3u8') || msg.includes('unauthorized');
};

// --- getFormats with redirect + retry-with-cookies logic ---
const getFormats = async (url) => {
  try {
    const original = getVideoUrl(url);
    const resolved = await resolveRedirect(original);
    const options = buildYtdlOptions({ url: resolved }, {
      dumpSingleJson: true,
      preferFreeFormats: true,
      skipDownload: true,
    });

    // call ytdl with resolved url
    let info;
    try {
      info = await ytdl(resolved, options);
    } catch (err) {
      // if 403 and cookies env present, try again with cookies
      if (is403Error(err) && process.env.YTDLP_COOKIE_PATH) {
        const retryOpts = buildYtdlOptions({ url: resolved }, { dumpSingleJson: true, skipDownload: true });
        retryOpts.cookies = process.env.YTDLP_COOKIE_PATH;
        info = await ytdl(resolved, retryOpts);
      } else {
        throw err;
      }
    }

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
    // give a helpful 403 hint
    if (is403Error(error)) {
      throw new Error('Failed to fetch formats (HTTP 403). Try setting YTDLP_COOKIE_PATH or YTDLP_AUTH_BEARER env vars.');
    }
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
      // if 403 and cookies available, retry with cookies immediately
      if (is403Error(error) && process.env.YTDLP_COOKIE_PATH && retries <= maxRetries) {
        // wait slightly then retry
        await new Promise((r) => setTimeout(r, 1000 * retries));
        continue;
      }

      if (retries > maxRetries) {
        if (is403Error(error)) {
          throw new Error('Failed to get video preview (HTTP 403). Set YTDLP_COOKIE_PATH or YTDLP_AUTH_BEARER and retry.');
        }
        throw new Error('Failed to get video preview: ' + (error.message || error));
      }
      // backoff
      await new Promise((resolve) => setTimeout(resolve, 1000 * retries));
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

// --- startDownload (resolves redirect and uses options) ---
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
      const options = buildYtdlOptions({ url: resolved });
      const args = [resolved, '-o', output];

      if (format) {
        args.push('-f', format);
      } else if (isSoundCloudUrl(resolved)) {
        args.push('-f', 'bestaudio[ext=mp3]');
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

      // use ytdl.exec for download; still compatible with yt-dlp-exec
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

// --- streamDownload (resolves redirect, sets headers early, spawns yt-dlp) ---
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
    const options = buildYtdlOptions({ url: resolved }, {
      format: format || (isSoundCloudUrl(resolved) ? 'bestaudio[ext=mp3]' : 'best'),
    });

    const fallbackName = `download-${streamId}`;
    const extension = isSoundCloudUrl(resolved) ? 'mp3' : 'mp4';

    res.setHeader('Content-Type', isSoundCloudUrl(resolved) ? 'audio/mpeg' : 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${fallbackName}.${extension}"`);
    res.setHeader('X-Stream-Id', streamId);
    if (typeof res.setTimeout === 'function') res.setTimeout(0);
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

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

    if (options.addHeader) {
      options.addHeader.forEach((hdr) => args.push('--add-header', hdr));
    }
    if (options.userAgent) args.push('--user-agent', options.userAgent);
    if (options.proxy) args.push('--proxy', options.proxy);
    if (options.referer) args.push('--referer', options.referer);
    if (options.cookies) args.push('--cookies', options.cookies);

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
      const entry = downloads.get(streamId);
      if (entry) {
        entry.status = 'error';
        entry.error = err.message;
      }
    });

    ytdlProc.on('close', (code) => {
      const entry = downloads.get(streamId);
      if (code === 0) {
        if (entry) entry.status = 'completed';
        try {
          if (!res.writableEnded) res.end();
        } catch (e) {}
      } else {
        if (!res.headersSent) {
          res.status(500).end('Download failed');
        } else {
          try {
            if (!res.writableEnded) res.end();
          } catch (e) {}
        }
        if (entry) {
          entry.status = 'error';
          entry.error = `yt-dlp exit code ${code}`;
        }
      }
    });

    res.on('close', () => {
      try {
        if (ytdlProc && !ytdlProc.killed) ytdlProc.kill('SIGTERM');
      } catch (e) {}
    });

    // background metadata fetch with configurable timeout
    (async () => {
      try {
        const metaTimeoutMs = parseInt(process.env.META_FETCH_TIMEOUT_MS || '30000', 10); // default 30s
        const metaOptions = buildYtdlOptions({ url: resolved }, {
          dumpSingleJson: true,
          skipDownload: true,
        });

        const metaPromise = ytdl(resolved, metaOptions);
        const metadata = await Promise.race([
          metaPromise,
          new Promise((_, rej) => setTimeout(() => rej(new Error('meta timeout')), metaTimeoutMs)),
        ]);

        const entry = downloads.get(streamId);
        if (entry) {
          entry.metadata = {
            id: metadata.id || resolved,
            title: metadata.title || null,
            thumbnail: metadata.thumbnail || null,
            duration: metadata.duration || null,
            uploader: metadata.uploader || null,
            view_count: metadata.view_count || null,
            filesize: metadata.filesize || metadata.filesize_approx || null,
            extractor: metadata.extractor_key || null,
            formats: metadata.formats ? metadata.formats.map((f) => ({ format_id: f.format_id, ext: f.ext, width: f.width, height: f.height, abr: f.abr })) : null,
          };
          console.log(`Metadata fetched for stream ${streamId}:`, entry.metadata.title || entry.metadata.id);
        }
      } catch (metaErr) {
        console.warn(`Metadata fetch failed for ${streamId}:`, metaErr && metaErr.message);
        const entry = downloads.get(streamId);
        if (entry) {
          entry.metadata = { error: metaErr && metaErr.message };
        }
      }
    })();
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
      try {
        if (!res.writableEnded) res.end();
      } catch (e) {}
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
