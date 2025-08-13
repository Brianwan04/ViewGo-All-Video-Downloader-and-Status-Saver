const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');
const ytdl = require('yt-dlp-exec');
const ytdlPath = path.join(__dirname, '../bin/yt-dlp');
const { validateUrl } = require('../utils/validation');

const http = require('http');
const https = require('https');
const { URL } = require('url');

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

const getFormats = async (url) => {
  try {
    const videoUrl = getVideoUrl(url);
    const options = buildYtdlOptions(url, {
      dumpSingleJson: true,
      preferFreeFormats: true,
    });

    const info = await ytdl(videoUrl, options);

    // map formats and normalize filesize
    const formats = (info.formats || [])
      .filter((f) => f.vcodec !== 'none' && f.acodec !== 'none')
      .map((f) => ({
        format_id: f.format_id,
        ext: f.ext,
        resolution: f.resolution || (f.height ? `${f.height}p` : 'unknown'),
        format_note: f.format_note,
        protocol: f.protocol || null,
        url: f.url || null,
        filesize: f.filesize || f.filesize_approx || null,
        // helpful for selection: progressive if ext is mp4 or protocol is http/https
        progressive: (f.ext && f.ext.toLowerCase() === 'mp4') ||
                    (f.protocol && /https?|http/.test(String(f.protocol))),
      }));

    // sort so formats with known filesize and progressive come first
    formats.sort((a, b) => {
      const aScore = (a.filesize ? 2 : 0) + (a.progressive ? 1 : 0);
      const bScore = (b.filesize ? 2 : 0) + (b.progressive ? 1 : 0);
      return bScore - aScore;
    });

    return formats;
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

      // choose the best progressive format with filesize if available
      const progressive = (info.formats || [])
        .filter(f => f.vcodec !== 'none' && f.acodec !== 'none' &&
                     (f.ext === 'mp4' || (f.protocol && /https?|http/.test(String(f.protocol)))))
        .map(f => ({ ...f, filesize: f.filesize || f.filesize_approx || null }))
        .filter(f => f.filesize)
        .sort((a, b) => (b.filesize || 0) - (a.filesize || 0))[0];

      const fileSize = progressive?.filesize || info.filesize || info.filesize_approx || null;
      const preferred_format = progressive?.format_id || null;

      return {
        id: info.id || videoUrl,
        title: info.title,
        thumbnail: info.thumbnail,
        duration: info.duration,
        platform: info.extractor_key,
        uploader: info.uploader,
        view_count: info.view_count,
        fileSize,
        preferred_format,
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
    dumpSingleJson: true,
    format: format || 'best',
  });

  const info = await ytdl(videoUrl, options);

  // 1. HLS (m3u8) detection (we return it if caller explicitly wants streaming)
  const hlsFormat = (info.formats || []).find(
    (f) => f.ext === 'm3u8_native' || f.protocol === 'm3u8_native' || (f.url && f.url.includes('.m3u8'))
  );
  if (hlsFormat?.url) {
    return {
      url: hlsFormat.url,
      format: hlsFormat.format_id,
      duration: info.duration,
      title: info.title,
      type: 'hls',
    };
  }

  // 2. If specific format requested and exists, return it
  if (format) {
    const chosen = (info.formats || []).find((f) => f.format_id === format);
    if (chosen?.url) {
      return {
        url: chosen.url,
        format: chosen.format_id,
        duration: info.duration,
        title: info.title,
        type: 'direct',
      };
    }
  }

  // 3. Prefer progressive formats with filesize (mp4 or https protocol)
  const progressiveWithSize = (info.formats || [])
    .filter(f => f.vcodec !== 'none' && f.acodec !== 'none')
    .map(f => ({ ...f, filesize: f.filesize || f.filesize_approx || null }))
    .filter(f => f.filesize && (f.ext === 'mp4' || (f.protocol && /https?|http/.test(String(f.protocol)))))
    .sort((a, b) => (b.filesize || 0) - (a.filesize || 0))[0];

  if (progressiveWithSize?.url) {
    return {
      url: progressiveWithSize.url,
      format: progressiveWithSize.format_id,
      duration: info.duration,
      title: info.title,
      fileSize: progressiveWithSize.filesize,
      type: 'direct',
    };
  }

  // 4. fallback: pick the largest progressive (even if filesize unknown)
  const progressive = (info.formats || [])
    .filter(f => f.protocol === 'https' && f.vcodec !== 'none' && f.acodec !== 'none')
    .sort((a, b) => (b.filesize || 0) - (a.filesize || 0))[0];

  if (progressive?.url) {
    return {
      url: progressive.url,
      format: progressive.format_id,
      duration: info.duration,
      title: info.title,
      fileSize: progressive.filesize || progressive.filesize_approx || null,
      type: 'direct',
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

async function proxyUrlToRes(proxyUrl, req, res, extraHeaders = {}) {
  // Follow up to 5 redirects (basic)
  const maxRedirects = 5;
  let redirects = 0;
  let currentUrl = proxyUrl;

  return new Promise((resolve, reject) => {
    const doRequest = (u) => {
      try {
        const parsed = new URL(u);
        const client = parsed.protocol === 'https:' ? https : http;

        const headers = {
          'user-agent': extraHeaders['user-agent'] || 'Mozilla/5.0',
          referer: extraHeaders['referer'] || undefined,
          ...extraHeaders,
        };

        const opts = {
          method: 'GET',
          headers,
        };

        const upstreamReq = client.request(parsed, opts, (upRes) => {
          // handle redirects
          if (upRes.statusCode >= 300 && upRes.statusCode < 400 && upRes.headers.location && redirects < maxRedirects) {
            redirects++;
            currentUrl = upRes.headers.location;
            upstreamReq.abort();
            return doRequest(currentUrl);
          }

          // forward headers only if not already sent
          if (!res.headersSent) {
            if (upRes.headers['content-type']) res.setHeader('Content-Type', upRes.headers['content-type']);
            if (upRes.headers['content-length']) res.setHeader('Content-Length', upRes.headers['content-length']);
          }

          // pipe
          upRes.pipe(res);
          upRes.on('end', () => resolve());
        });

        upstreamReq.on('error', (err) => {
          reject(err);
        });

        // abort upstream if client closes
        req.on('close', () => {
          try { upstreamReq.abort(); } catch (e) {}
        });

        upstreamReq.end();
      } catch (err) {
        reject(err);
      }
    };

    doRequest(currentUrl);
  });
}

const streamDownload = async (url, format, res, req) => {
  const videoUrl = getVideoUrl(url);

  try {
    const options = buildYtdlOptions(url, {
      dumpSingleJson: true,
      format: format || 'best',
    });

    const info = await ytdl(videoUrl, options);
    const safeTitle = (info.title || 'video').replace(/[^\w\s]/gi, '');
    const extension = 'mp4';

    // Prefer a progressive format with known filesize and direct URL
    const progressiveWithSize = (info.formats || [])
      .filter(f => f.vcodec !== 'none' && f.acodec !== 'none')
      .map(f => ({ ...f, filesize: f.filesize || f.filesize_approx || null }))
      .filter(f => f.filesize && (f.ext === 'mp4' || (f.protocol && /https?|http/.test(String(f.protocol)))))
      .sort((a, b) => (b.filesize || 0) - (a.filesize || 0))[0];

    const chosenFormat = progressiveWithSize || (info.formats || []).find(f => f.format_id === format) || null;

    // set Content-Disposition early (safe)
    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.${extension}"`);

    // Helper to cleanly kill child and destroy streams
    const killChild = (child) => {
      try { if (child && !child.killed) child.kill('SIGTERM'); } catch(e) {}
    };

    // If chosen format gives us a direct URL, proxy that URL (preserves real Content-Length)
    if (chosenFormat && chosenFormat.url) {
      const proxyUrl = chosenFormat.url;
      const extraHeaders = {};
      if (options.userAgent) extraHeaders['user-agent'] = options.userAgent;
      if (options.referer) extraHeaders['referer'] = options.referer;
      if (options.addHeader) {
        options.addHeader.forEach(h => {
          const [k, ...rest] = h.split(':');
          if (k && rest.length) extraHeaders[k.trim()] = rest.join(':').trim();
        });
      }

      // Prefer got.stream via dynamic import (handles redirects & TLS robustly)
      let upstream;
      try {
        const { default: got } = await import('got'); // dynamic ESM import
        upstream = got.stream(proxyUrl, { headers: extraHeaders });
      } catch (err) {
        // dynamic import or got failed — fall back to native proxy
        console.warn('got import/stream failed, falling back to native proxy:', err && err.message);
        try {
          await proxyUrlToRes(proxyUrl, req, res, extraHeaders);
          return;
        } catch (proxyErr) {
          console.error('native proxy failed:', proxyErr && proxyErr.message);
          if (!res.headersSent) res.status(502).json({ error: 'Upstream proxy failed' });
          return;
        }
      }

      if (!upstream || typeof upstream.on !== 'function') {
        console.error('Upstream stream invalid, falling back to native proxy');
        try {
          await proxyUrlToRes(proxyUrl, req, res, extraHeaders);
          return;
        } catch (proxyErr) {
          console.error('native proxy failed:', proxyErr && proxyErr.message);
          if (!res.headersSent) res.status(502).json({ error: 'Upstream proxy failed' });
          return;
        }
      }

      // Only set Content-Length/Type if upstream provides them and headers are not sent yet
      upstream.on('response', (upstreamResp) => {
        try {
          if (!res.headersSent) {
            if (upstreamResp.headers['content-length']) {
              res.setHeader('Content-Length', upstreamResp.headers['content-length']);
            }
            if (upstreamResp.headers['content-type'] && !res.getHeader('Content-Type')) {
              res.setHeader('Content-Type', upstreamResp.headers['content-type']);
            }
          }
        } catch (e) {
          console.warn('Error while setting upstream headers', e && e.message);
        }
      });

      upstream.on('error', (err) => {
        console.error('Upstream stream error:', err && err.message);
        if (!res.headersSent) {
          try { res.status(502).end('Upstream stream error'); } catch (e) {}
        } else {
          try { res.destroy(); } catch (e) {}
        }
      });

      // if client disconnects, destroy upstream
      req.on('close', () => {
        try { upstream.destroy(); } catch (e) {}
      });

      // pipe upstream -> client
      upstream.pipe(res);

      res.on('close', () => {
        try { upstream.destroy(); } catch (e) {}
      });

      return;
    }

    // FALLBACK: no direct format URL — spawn yt-dlp and pipe stdout (chunked)
    const args = [
      videoUrl,
      '-f',
      format || (chosenFormat ? chosenFormat.format_id : 'best'),
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

    // pipe child stdout to response (chunked)
    ytdlProc.stdout.pipe(res);

    // when client disconnects, kill child
    req.on('close', () => {
      killChild(ytdlProc);
    });

    // error handlers
    ytdlProc.stderr.on('data', (data) => {
      console.error('[yt-dlp stderr]', data.toString());
    });

    ytdlProc.on('error', (err) => {
      console.error('Failed to spawn yt-dlp:', err);
      if (!res.headersSent) res.status(500).end('Download failed');
      killChild(ytdlProc);
    });

    ytdlProc.on('close', (code) => {
      if (code !== 0 && !res.headersSent) {
        console.error('yt-dlp closed with code', code);
        if (!res.headersSent) res.status(500).end('Download failed');
      }
    });

    res.on('error', (err) => {
      console.error('Response error (client likely aborted):', err && err.message);
      killChild(ytdlProc);
    });

  } catch (err) {
    if (err.message && (err.message.includes('login required') || err.message.includes('rate-limit reached'))) {
      if (!res.headersSent) res.status(401).json({ error: 'Instagram authentication required' });
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
