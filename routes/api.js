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

// Root endpoint
router.get('/', (req, res) => {
  res.send('Video Downloader API is running');
});

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

// GET Preview (for non-Instagram platforms)
router.get('/preview', validateUrlInputGET, async (req, res) => {
  const { cookies, platform } = req.query;
  try {
    const previewInfo = await downloadService.getVideoPreview({
      url: req.validatedUrl,
      platform: platform || 'default',
      config: { cookies }
    });
    res.json(previewInfo);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST Preview (specifically for Instagram)
router.post('/preview', validateUrlInputPOST, async (req, res) => {
  const { cookies, platform } = req.body;
  try {
    const previewInfo = await downloadService.getVideoPreview({
      url: req.validatedUrl,
      platform: platform || 'default',
      config: { cookies }
    });
    res.json(previewInfo);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET Formats (for non-Instagram platforms)
router.get('/formats', validateUrlInputGET, async (req, res) => {
  const { cookies, platform } = req.query;
  try {
    const formats = await downloadService.getFormats({
      url: req.validatedUrl,
      platform: platform || 'default',
      config: { cookies }
    });
    res.json({ formats });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST Formats (specifically for Instagram)
router.post('/formats', validateUrlInputPOST, async (req, res) => {
  const { cookies, platform } = req.body;
  try {
    const formats = await downloadService.getFormats({
      url: req.validatedUrl,
      platform: platform || 'default',
      config: { cookies }
    });
    res.json({ formats });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Stream-download endpoint
router.get('/stream-download', validateUrlInputGET, async (req, res) => {
  const { format, cookies, platform } = req.query;
  await downloadService.streamDownload(
    { url: req.validatedUrl, platform, config: { cookies } },
    format,
    res
  );
});

// Download endpoint
router.post('/download', validateUrlInput, asyncHandler(async (req, res) => {
  const { url, format } = req.body;
  const downloadId = await downloadService.startDownload(req.validatedUrl, format);
  res.json({ id: downloadId });
}));

// SSE progress stream
router.get('/download/:id/progress', (req, res) => {
  const { id } = req.params;
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
  const streamInfo = await downloadService.getStreamUrl(req.validatedUrl, format);
  res.json(streamInfo);
}));

// Stream download endpoint
/*router.get('/stream-download', validateUrlInput, async (req, res) => {
  const { format } = req.query;
  await downloadService.streamDownload(req.validatedUrl, format, res);
});

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
});*/

module.exports = router;
