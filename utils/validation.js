const validator = require('validator');
const { URL } = require('url');

const extractFirstUrlFromText = (text) => {
  if (!text || typeof text !== 'string') return null;

  // 1) Prefer vm.tiktok.com shortlinks (allow hyphens in ID)
  const vmMatch = text.match(/(?:https?:\/\/)?vm\.tiktok\.com\/[A-Za-z0-9-]+\/?/i);
  if (vmMatch) {
    let out = vmMatch[0];
    if (!out.startsWith('http')) out = `https://${out}`;
    // Ensure trailing slash for TikTok shortlinks
    if (!out.endsWith('/')) out += '/';
    return sanitizeTrailing(out);
  }

  // 2) Match http(s)://... up to whitespace (generic)
  const httpMatch = text.match(/https?:\/\/[^\s)'"<>]+/i);
  if (httpMatch) return sanitizeTrailing(httpMatch[0]);

  // 3) Match www.something (no protocol)
  const wwwMatch = text.match(/(?:www\.)[^\s)'"<>]+/i);
  if (wwwMatch) return sanitizeTrailing(`https://${wwwMatch[0]}`);

  // 4) Generic domain.tld/... fallback
  const domainMatch = text.match(/[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:\/[^\s]*)?/i);
  if (domainMatch) {
    let candidate = domainMatch[0];
    if (!candidate.startsWith('http')) candidate = `https://${candidate}`;
    return sanitizeTrailing(candidate);
  }

  return null;
};

const sanitizeTrailing = (s) => s.replace(/^[<\s"']+|[>\s"']+$/g, '').replace(/[),.?!]+$/g, '');

const validateUrl = (inputUrl) => {
  let urlCandidate = inputUrl;
  console.log(`Validating input URL: ${inputUrl}`); // Debug log

  // Always try to extract a clean URL first if input is a string
  if (typeof urlCandidate === 'string') {
    const extracted = extractFirstUrlFromText(urlCandidate);
    if (extracted) {
      urlCandidate = extracted;
      console.log(`Extracted URL: ${urlCandidate}`); // Debug log
    }
  }

  if (!urlCandidate) {
    throw new Error('Invalid URL format');
  }

  // Trim and remove surrounding whitespace/punctuation
  urlCandidate = urlCandidate.trim().replace(/^[<\s"']+|[>\s"']+$/g, '');
  urlCandidate = urlCandidate.replace(/[),.?!]+$/g, '');

  // Add protocol if missing
  if (!urlCandidate.includes('://')) {
    urlCandidate = 'https://' + urlCandidate;
  }

  // Limit length to avoid abuse
  if (urlCandidate.length > 2000) throw new Error('URL too long');

  // Validate URL format
  if (!validator.isURL(urlCandidate, {
    protocols: ['http', 'https'],
    require_protocol: true,
    allow_underscores: true,
  })) {
    throw new Error('Invalid URL format');
  }

  // Additional validation for TikTok shortlinks
  if (urlCandidate.includes('vm.tiktok.com')) {
    if (!urlCandidate.match(/^https:\/\/vm\.tiktok\.com\/[A-Za-z0-9-]+\/$/)) {
      throw new Error('Invalid TikTok shortlink format');
    }
  }

  // Validate supported platforms
  const supportedPlatforms = [
    'youtube.com',
    'youtu.be',
    'tiktok.com',
    'vm.tiktok.com',
    'tiktoklite.com',
    'instagram.com',
    'facebook.com',
    'fb.watch',
    'reddit.com',
    'v.redd.it',
    'vimeo.com',
    'dailymotion.com',
    'twitter.com',
    'x.com',
    'linkedin.com',
    'pinterest.com',
    'soundcloud.com',
    'twitch.tv',
    'rumble.com',
    'bitchute.com',
    'bilibili.com',
    'snapchat.com',
    'threads.net',
    'threads.com',
    'likee.video',
    'triller.co',
    '9gag.com',
    'dai.ly',
    'dai.ly.com'
  ];

  let hostname;
  try {
    hostname = new URL(urlCandidate).hostname.toLowerCase();
  } catch (e) {
    throw new Error('Invalid URL format');
  }

  const isSupported = supportedPlatforms.some(domain => hostname === domain || hostname.endsWith('.' + domain));
  if (!isSupported) {
    throw new Error('Unsupported platform');
  }

  return urlCandidate;
};

// For GET requests (query parameters)
const validateUrlInputGET = (req, res, next) => {
  const url = req.query.url;
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    req.validatedUrl = validateUrl(decodeURIComponent(url)); // Decode URL-encoded input
    next();
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// For POST requests (body parameters)
const validateUrlInputPOST = (req, res, next) => {
  const url = req.body.url;
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    req.validatedUrl = validateUrl(url);
    next();
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const validateSearchInput = (req, res, next) => {
  if (!req.body.query) {
    return res.status(400).json({ error: 'Search query is required' });
  }
  req.validatedQuery = req.body.query.trim().substring(0, 100);
  next();
};

module.exports = {
  extractFirstUrlFromText,
  validateUrl,
  validateSearchInput,
  validateUrlInputGET,
  validateUrlInputPOST,
  sanitizeSearchQuery: (query) => {
    if (typeof query !== 'string') {
      throw new Error('Search query must be a string');
    }
    return query.trim().replace(/[^\w\s-]/g, '').substring(0, 100);
  }
};
