const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const NodeCache = require('node-cache');
const { exec } = require('child_process');
const { promisify } = require('util');
const { searchYouTubeTrailer } = require('./youtube-search');
const fs = require('fs');
const fetch = require('node-fetch');

const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3001;
const YTDLP_COOKIES = process.env.YTDLP_COOKIES; // optional: path to cookies.txt file
const YTDLP_EXTRACTOR_ARGS = process.env.YTDLP_EXTRACTOR_ARGS || 'youtube:player_client=android'; // optional: custom extractor args

function buildYtDlpCommand(youtubeUrl) {
  const baseFormat = 'best[height<=720][ext=mp4]/best[height<=720]/best';
  const hasCookies = Boolean(YTDLP_COOKIES && fs.existsSync(YTDLP_COOKIES));
  const cookiesArg = hasCookies ? ` --cookies "${YTDLP_COOKIES}"` : '';
  // If cookies are present, prefer them and avoid forcing an extractor client that may ignore cookies
  const extractorArgs = !hasCookies && YTDLP_EXTRACTOR_ARGS
    ? ` --extractor-args "${YTDLP_EXTRACTOR_ARGS}"`
    : '';
  return `yt-dlp -f "${baseFormat}" -g --no-playlist${cookiesArg}${extractorArgs} "${youtubeUrl}"`;
}

// TMDB API configuration
const TMDB_API_KEY = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI0MzljNDc4YTc3MWYzNWMwNTAyMmY5ZmVhYmNjYTAxYyIsIm5iZiI6MTcwOTkxMTEzNS4xNCwic3ViIjoiNjVlYjJjNWYzODlkYTEwMTYyZDgyOWU0Iiwic2NvcGVzIjpbImFwaV9yZWFkIl0sInZlcnNpb24iOjF9.gosBVl1wYUbePOeB9WieHn8bY9x938-GSGmlXZK_UVM';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

// Cache configuration - cache trailer URLs for 24 hours
const trailerCache = new NodeCache({ 
  stdTTL: 24 * 60 * 60, // 24 hours
  checkperiod: 60 * 60   // Check for expired keys every hour
});

// Rate limiting - 10 requests per minute per IP
const rateLimiter = new RateLimiterMemory({
  keyPrefix: 'trailer_api',
  points: 10, // Number of requests
  duration: 60, // Per 60 seconds
});

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Rate limiting middleware
const rateLimiterMiddleware = async (req, res, next) => {
  try {
    await rateLimiter.consume(req.ip);
    next();
  } catch (rejRes) {
    res.status(429).json({ 
      error: 'Too many requests', 
      retryAfter: Math.round(rejRes.msBeforeNext / 1000) || 1 
    });
  }
};

// TMDB API functions
async function getTrailerFromTMDB(tmdbId, type = 'movie') {
  try {
    const endpoint = type === 'movie' 
      ? `${TMDB_BASE_URL}/movie/${tmdbId}/videos?language=en-US`
      : `${TMDB_BASE_URL}/tv/${tmdbId}/videos?language=en-US`;
    
    console.log(`🔍 Fetching trailers from TMDB for ${type} ID: ${tmdbId}`);
    
    const response = await fetch(endpoint, {
      headers: {
        'Authorization': `Bearer ${TMDB_API_KEY}`,
        'accept': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`TMDB API error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    
    // Find the first trailer (prefer official trailers)
    const trailers = data.results || [];
    const officialTrailer = trailers.find(video => 
      video.type === 'Trailer' && 
      video.site === 'YouTube' && 
      video.official === true
    );
    
    const trailer = officialTrailer || trailers.find(video => 
      video.type === 'Trailer' && 
      video.site === 'YouTube'
    );
    
    if (!trailer) {
      console.log(`❌ No YouTube trailer found in TMDB for ${type} ID: ${tmdbId}`);
      return null;
    }
    
    const youtubeUrl = `https://www.youtube.com/watch?v=${trailer.key}`;
    console.log(`✅ Found TMDB trailer: ${youtubeUrl}`);
    
    return youtubeUrl;
  } catch (error) {
    console.error(`❌ TMDB API error for ${type} ID ${tmdbId}:`, error.message);
    return null;
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    cache: {
      keys: trailerCache.keys().length,
      stats: trailerCache.getStats()
    }
  });
});

// Auto-search trailer endpoint (supports both TMDB and YouTube search)
app.get('/search-trailer', rateLimiterMiddleware, async (req, res) => {
  try {
    const { title, year, tmdbId, type } = req.query;
    
    // Enhanced logging to debug what we're receiving
    console.log('🔍 Received request parameters:', {
      title: title || 'NOT_PROVIDED',
      year: year || 'NOT_PROVIDED', 
      tmdbId: tmdbId || 'NOT_PROVIDED',
      type: type || 'NOT_PROVIDED',
      allParams: Object.keys(req.query)
    });
    
    // Validate required parameters
    if (!title && !tmdbId) {
      console.log('❌ Missing required parameters - need either title or tmdbId');
      return res.status(400).json({ 
        error: 'Either title or tmdbId parameter is required' 
      });
    }
    
    // Create cache key
    const cacheKey = tmdbId ? `tmdb_${tmdbId}_${type || 'movie'}` : `search_${title}_${year}`;
    
    // Check cache first
    const cachedResult = trailerCache.get(cacheKey);
    if (cachedResult) {
      console.log(`🎯 Cache hit for ${tmdbId ? 'TMDB' : 'search'}: ${title || tmdbId} (${year})`);
      return res.json(cachedResult);
    }
    
    let youtubeUrl = null;
    
    // Try TMDB first if tmdbId is provided
    if (tmdbId) {
      console.log(`🎯 Using TMDB API path for: ${tmdbId} (${type || 'movie'})`);
      youtubeUrl = await getTrailerFromTMDB(tmdbId, type || 'movie');
    } else {
      console.log(`🔍 No TMDB ID provided, using YouTube search path`);
    }
    
    // Fallback to YouTube search if TMDB fails or no tmdbId provided
    if (!youtubeUrl && title) {
      console.log(`🔍 Auto-searching trailer for: ${title} (${year})`);
      const searchQuery = `${title} ${year || ''} official trailer`.trim();
      youtubeUrl = await searchYouTubeTrailer(searchQuery);
    }
    
    if (!youtubeUrl) {
      console.log(`❌ No trailer found for: ${title || tmdbId} (${year})`);
      return res.status(404).json({ 
        error: 'Trailer not found' 
      });
    }
    
    // Now get the direct streaming URL
    const command = buildYtDlpCommand(youtubeUrl);
    
    const { stdout, stderr } = await execAsync(command, { 
      timeout: 30000,
      maxBuffer: 1024 * 1024
    });
    
    if (stderr && !stderr.includes('WARNING')) {
      console.error('yt-dlp stderr:', stderr);
    }
    
    const directUrl = stdout.trim();
    
    if (!directUrl || !isValidUrl(directUrl)) {
      console.log(`❌ No valid streaming URL found for: ${title} (${year})`);
      return res.status(404).json({ 
        error: 'Trailer not found or invalid URL' 
      });
    }
    
    const result = {
      url: directUrl,
      title: title || 'Unknown',
      year: year || 'Unknown',
      source: 'youtube',
      youtubeUrl: youtubeUrl,
      cached: false,
      timestamp: new Date().toISOString()
    };
    
    // Cache the result
    trailerCache.set(cacheKey, result);
    console.log(`✅ Successfully found and processed trailer for: ${title} (${year})`);
    
    res.json(result);
    
  } catch (error) {
    console.error('Error in auto-search:', error);
    
    if (error.code === 'TIMEOUT') {
      return res.status(408).json({ 
        error: 'Request timeout - video processing took too long' 
      });
    }
    
    res.status(500).json({ 
      error: 'Internal server error',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
    });
  }
});

// Main trailer endpoint
app.get('/trailer', rateLimiterMiddleware, async (req, res) => {
  try {
    const { youtube_url, title, year } = req.query;
    
    // Validate required parameters
    if (!youtube_url) {
      return res.status(400).json({ 
        error: 'youtube_url parameter is required' 
      });
    }
    
    // Create cache key
    const cacheKey = `trailer_${title}_${year}_${youtube_url}`;
    
    // Check cache first
    const cachedResult = trailerCache.get(cacheKey);
    if (cachedResult) {
      console.log(`🎯 Cache hit for: ${title} (${year})`);
      return res.json(cachedResult);
    }
    
    console.log(`🔍 Fetching trailer for: ${title} (${year})`);
    
    // Use yt-dlp to get direct streaming URL
    // Prefer MP4 format, max 720p for better compatibility
    const command = buildYtDlpCommand(youtube_url);
    
    const { stdout, stderr } = await execAsync(command, { 
      timeout: 30000, // 30 second timeout
      maxBuffer: 1024 * 1024 // 1MB buffer
    });
    
    if (stderr && !stderr.includes('WARNING')) {
      console.error('yt-dlp stderr:', stderr);
    }
    
    const directUrl = stdout.trim();
    
    if (!directUrl || !isValidUrl(directUrl)) {
      console.log(`❌ No valid URL found for: ${title} (${year})`);
      return res.status(404).json({ 
        error: 'Trailer not found or invalid URL' 
      });
    }
    
    const result = {
      url: directUrl,
      title: title || 'Unknown',
      year: year || 'Unknown',
      source: 'youtube',
      cached: false,
      timestamp: new Date().toISOString()
    };
    
    // Cache the result
    trailerCache.set(cacheKey, result);
    console.log(`✅ Successfully fetched trailer for: ${title} (${year})`);
    
    res.json(result);
    
  } catch (error) {
    console.error('Error fetching trailer:', error);
    
    if (error.code === 'TIMEOUT') {
      return res.status(408).json({ 
        error: 'Request timeout - video processing took too long' 
      });
    }
    
    if (error.message.includes('not found') || error.message.includes('unavailable')) {
      return res.status(404).json({ 
        error: 'Trailer not found' 
      });
    }
    
    res.status(500).json({ 
      error: 'Internal server error',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
    });
  }
});

// Get cached trailers (for debugging)
app.get('/cache', (req, res) => {
  const keys = trailerCache.keys();
  const cacheData = {};
  
  keys.forEach(key => {
    cacheData[key] = trailerCache.get(key);
  });
  
  res.json({
    count: keys.length,
    keys: keys,
    data: cacheData
  });
});

// Clear cache endpoint (for maintenance)
app.delete('/cache', (req, res) => {
  trailerCache.flushAll();
  res.json({ 
    message: 'Cache cleared successfully',
    timestamp: new Date().toISOString()
  });
});

// Helper function to validate URLs
function isValidUrl(string) {
  try {
    new URL(string);
    return true;
  } catch (_) {
    return false;
  }
}

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ 
    error: 'Internal server error' 
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Endpoint not found',
    availableEndpoints: ['/health', '/trailer', '/cache']
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Trailer server running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🎬 Trailer endpoint: http://localhost:${PORT}/trailer`);
  console.log(`💾 Cache endpoint: http://localhost:${PORT}/cache`);
});

module.exports = app;
