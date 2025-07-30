// routes/api.js
const express = require('express');
const router = express.Router();
const { validateSearchInput, validateUrlInput } = require('../utils/validation');
const youtubeService = require('../services/youtubeService');
const downloadService = require('../services/downloadService');
const path = require('path');

// Error handling middleware
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next))
    .catch(next);
};

// Search endpoint
router.post('/search', validateSearchInput, async (req, res) => {
  const { query } = req.body;
  try {
    const results = await youtubeService.search(req.validatedQuery);
    res.json({ results });
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// Get formats endpoint
router.get('/formats', validateUrlInput, async (req, res) => {
  try {
    const formats = await downloadService.getFormats(req.validatedUrl);
    res.json({ formats });
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// Preview endpoint
router.get('/preview', validateUrlInput, async (req, res) => {
  try {
    const previewInfo = await downloadService.getVideoPreview(req.validatedUrl);
    res.json(previewInfo);
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// Download endpoint
router.post('/download', validateUrlInput, asyncHandler(async (req, res) => {
  const { url, format } = req.body;
  const downloadId = await downloadService.startDownload(url, format);
  res.json({ id: downloadId });
}));

// SSE progress stream - FIXED
router.get('/download/:id/progress', (req, res) => {
  const { id } = req.params;
  
  // Add SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  // Monkey-patch res.flush if missing
  if (typeof res.flush !== 'function') {
    res.flush = () => {}; // No-op function
  }
  
  downloadService.setupProgressStream(id, res);
});

// Get download status
router.get('/download/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const status = downloadService.getDownloadStatus(id);
  
  if (status.filePath) {
    const filename = path.basename(status.filePath);
    status.downloadUrl = `/downloads/${filename}`;
  }
  
  res.json(status);
}));

// Stream endpoint
router.get('/stream', validateUrlInput, asyncHandler(async (req, res) => {
  const { url, format } = req.query;
  const streamInfo = await downloadService.getStreamUrl(url, format);
  res.json(streamInfo);
}));

// Enhanced error handler
router.use((err, req, res, next) => {
  console.error('API Error:', err.message);
  
  if (!res.headersSent) {
    res.status(500).json({ 
      error: err.message || 'Internal server error',
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  } else {
    console.error('Response already sent, cannot send error:', err.message);
  }
});

// Change the route to use validateUrlInput middleware
router.get('/stream-download', validateUrlInput, async (req, res) => {
  const { url, format } = req.query;
  await downloadService.streamDownload(url, format, res);
});



module.exports = router;
