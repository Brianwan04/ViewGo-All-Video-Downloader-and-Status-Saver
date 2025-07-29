const redis = require('redis');
const { promisify } = require('util');
const NodeCache = require('node-cache');

let cacheClient;
let cacheEnabled = false;
const memoryCache = new NodeCache({ stdTTL: 60 * 60, checkperiod: 120 });

const initializeCache = async () => {
  if (process.env.REDIS_URL) {
    try {
      cacheClient = redis.createClient({ url: process.env.REDIS_URL });
      await cacheClient.connect();
      cacheEnabled = true;
      console.log('Connected to Redis');
    } catch (error) {
      console.error('Redis connection error, using in-memory cache', error);
      cacheEnabled = false;
    }
  } else {
    console.log('Using in-memory cache');
  }
};

const getCache = async (key) => {
  if (cacheEnabled) {
    try {
      const value = await cacheClient.get(key);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      console.error('Redis get error', error);
      return null;
    }
  } else {
    return memoryCache.get(key);
  }
};

const setCache = async (key, value, ttl) => {
  if (cacheEnabled) {
    try {
      await cacheClient.set(key, JSON.stringify(value), 'EX', ttl);
    } catch (error) {
      console.error('Redis set error', error);
    }
  } else {
    memoryCache.set(key, value, ttl);
  }
};

module.exports = {
  initializeCache,
  getCache,
  setCache,
};