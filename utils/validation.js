const validator = require('validator');

const sanitizeSearchQuery = (query) => {
  if (typeof query !== 'string') {
    throw new Error('Search query must be a string');
  }

  // Remove special characters and limit length
  return query.trim()
    .replace(/[^\w\s-]/g, '')
    .substring(0, 100);
};

const validateUrl = (inputUrl) => {
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

  // Validate supported platforms
  const supportedPlatforms = [
    'youtube.com',
    'youtu.be',
    'tiktok.com',
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
    'dai.ly.com'
  ];

  if (!supportedPlatforms.some(domain => url.includes(domain))) {
    throw new Error('Unsupported platform');
  }

  return url;
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
