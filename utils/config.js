// utils/config.js - Configuration loader
require('dotenv').config();

module.exports = {
  PORT: process.env.PORT || 3000,
  YOUTUBE_API_KEYS: process.env.YOUTUBE_API_KEYS || '',
  FILE_RETENTION_MINUTES: process.env.FILE_RETENTION_MINUTES || 30
};