// services/youtubeService.js
const { google } = require('googleapis');
const { getCache, setCache } = require('../utils/cache');
const { sanitizeSearchQuery } = require('../utils/validation');

const youtube = google.youtube('v3');
const API_KEYS = process.env.YOUTUBE_API_KEYS.split(',');
let currentKeyIndex = 0;

// Rotate API keys
const getNextApiKey = () => {
  const key = API_KEYS[currentKeyIndex];
  currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
  return key;
};

// Search YouTube
const search = async (query) => {
  const sanitizedQuery = sanitizeSearchQuery(query);
  
  // Check cache first
  const cachedResults = await getCache(sanitizedQuery);
  if (cachedResults) {
    return cachedResults;
  }

  try {
    const response = await youtube.search.list({
      key: getNextApiKey(),
      part: 'snippet',
      q: sanitizedQuery,
      type: 'video',
      maxResults: 10,
    });

    const results = response.data.items.map(item => ({
      id: item.id.videoId,
      title: item.snippet.title,
      thumbnail: item.snippet.thumbnails.default.url,
      channelTitle: item.snippet.channelTitle,
      publishedAt: item.snippet.publishedAt,
    }));

    // Cache results for 1 hour
    await setCache(sanitizedQuery, results, 60 * 60);
    return results;
  } catch (error) {
    if (error.response && error.response.status === 403) {
      console.error('YouTube API quota exceeded, rotating keys...');
    }
    throw new Error('YouTube search failed: ' + error.message);
  }
};

module.exports = { search };