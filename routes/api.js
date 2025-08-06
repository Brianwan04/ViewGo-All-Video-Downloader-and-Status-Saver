const express = require('express');
const router = express.Router();
const { 
  validateSearchInput, 
  validateUrlInputGET, 
  validateUrlInputPOST 
} = require('../utils/validation');
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

router.post('/auth/instagram', async (req, res) => {
  const { url, cookies } = req.body;
  if (!url || !cookies) {
    return res.status(400).json({ success: false, error: 'URL and cookies are required' });
  }

  try {
    // Save cookies to a temporary file
    const fs = require('fs').promises;
    const cookieFilePath = `/tmp/instagram_cookies_${Date.now()}.txt`;
    await fs.writeFile(cookieFilePath, cookies);

    // Fetch preview with cookies
    const previewData = await getVideoPreview(url, cookieFilePath);
    // Clean up cookie file
    await fs.unlink(cookieFilePath);
    res.json({ success: true, data: previewData });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Search endpoint
router.post('/search', validateSearchInput, async (req, res) => {
  try {
    const results = await youtubeService.search(req.validatedQuery);
    res.json({ results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET Preview (for non-Instagram platforms)
/*router.get('/preview', validateUrlInputGET, async (req, res) => {
  try {
    const { cookies, platform } = req.query;
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
  try {
    const { cookies, platform } = req.body;
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
  try {
    const { cookies, platform } = req.query;
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
  try {
    const { cookies, platform } = req.body;
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
*/
router.post('/formats', async (req, res) => {
  const { url, platform, cookies } = req.body;
  try {
    const formats = await getFormats({ url, platform, cookies });
    res.json({ formats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/preview', async (req, res) => {
  const { url, platform, cookies } = req.body;
  try {
    const preview = await getVideoPreview({ url, platform, cookies });
    res.json(preview);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});*/
// Stream-download endpoint
router.get('/stream-download', validateUrlInputGET, async (req, res) => {
  const { format, cookies, platform } = req.query;
  await downloadService.streamDownload(
    { url: req.validatedUrl, platform, config: { cookies } },
    format,
    res
  );
});

router.post('/stream-download', async (req, res) => {
  const { url, format, platform, cookies } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'Missing url' });
  }

  try {
    // Delegate to your service, which should call:
    // buildYtdlOptions({ url, platform, cookies }, { format, dumpSingleJson: true })
    await streamDownload({ url, platform, cookies }, format, res);
    // streamDownload handles piping and headers itself
  } catch (err) {
    console.error('Streaming error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'Stream failed' });
    }
  }
});


// Download endpoint - Updated to use POST validator
router.post('/download', validateUrlInputPOST, asyncHandler(async (req, res) => {
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

// Stream endpoint - Updated to use GET validator
router.get('/stream', validateUrlInputGET, asyncHandler(async (req, res) => {
  const { url, format } = req.query;
  const streamInfo = await downloadService.getStreamUrl(req.validatedUrl, format);
  res.json(streamInfo);
}));

module.exports = router;
