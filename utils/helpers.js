// utils/helpers.js - Helper functions
module.exports = {
    sanitizeFilename: (str) => {
      return str
        .replace(/[^a-z0-9]/gi, '_')
        .substring(0, 50);
    },
    
    isYouTubeSearchQuery: (input) => {
      // Simple heuristic: if it's not a URL and has space, it's a search query
      return !input.includes('://') && input.includes(' ');
    }
  };