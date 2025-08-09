const validator = require('validator');
const { URL } = require('url');

const sanitizeSearchQuery = (query) => {
  if (typeof query !== 'string') {
    throw new Error('Search query must be a string');
  }

  // Remove special characters and limit length
  return query.trim()
    .replace(/[^\w\s-]/g, '')
    .substring(0, 100);
};

const extractFirstUrlFromText = (text) => {
  if (!text || typeof text !== 'string') return null;

  // Try to match https:// or http:// or www.x or vm.tiktok.com/... (no protocol)
  const regex = /(https?:\/\/[^\s]+)/i;
  let match = text.match(regex);
  if (match) return match[0].replace(/[),.?!]+$/g, ''); // strip trailing punctuation

  // match www.something (no protocol)
  match = text.match(/(www\.[^\s]+)/i);
  if (match) return `https://${match[0].replace(/[),.?!]+$/g, '')}`;

  // match vm.tiktok.com shortlinks without protocol (common in "shared" text)
  match = text.match(/(vm\.tiktok\.com\/[A-Za-z0-9\/_\-\.]+)/i);
  if (match) return `https://${match[0].replace(/[),.?!]+$/g, '')}`;

  return null;
};

/**
 * Validate & normalize URL input (updated to accept messy TikTok Lite share text)
 */
const validateUrl = (inputUrl) => {
  let urlCandidate = inputUrl;

  // if input looks like large pasted text, try to extract URL first
  if (typeof urlCandidate === 'string' && urlCandidate.length > 100 && !urlCandidate.includes('://')) {
    const extracted = extractFirstUrlFromText(urlCandidate);
    if (extracted) urlCandidate = extracted;
  }

  // If still not found and input is a string, try to extract anyway
  if (typeof urlCandidate === 'string' && !urlCandidate.includes('://')) {
    const maybe = extractFirstUrlFromText(urlCandidate);
    if (maybe) urlCandidate = maybe;
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
    protocols: ['http','https'],
    require_protocol: true,
    allow_underscores: true,
  })) {
    throw new Error('Invalid URL format');
  }

/*const validateUrl = (inputUrl) => {
  let url = inputUrl;

  // Add protocol if missing
  if (!url.includes('://')) {
    url = 'https://' + url;
  }

  // Validate URL format
  if (!validator.isURL(url, {
    protocols: ['http','https'],
    require_protocol: true,
    allow_underscores: true,
  })) {
    throw new Error('Invalid URL format');
  }
*/
  // Validate supported platforms
  const supportedPlatforms = [
    'youtube.com',
    'youtu.be',
    'tiktok.com',
    'vm.tiktok.com',         // short links
    'tiktoklite.com',       // lite domain if it ever appears
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
    req.validatedUrl = validateUrl(url);
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
  validateUrl,
  validateSearchInput,
  validateUrlInputGET,  // For GET requests
  validateUrlInputPOST, // For POST requests
  sanitizeSearchQuery
};
