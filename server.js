const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const { exec } = require('child_process');
const { promisify } = require('util');
const { searchYouTubeTrailer } = require('./youtube-search');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3001;
const YTDLP_COOKIES = process.env.YTDLP_COOKIES; // optional: path to cookies.txt file
const YTDLP_EXTRACTOR_ARGS = process.env.YTDLP_EXTRACTOR_ARGS || 'youtube:player_client=android'; // optional: custom extractor args

function buildYtDlpCommand(youtubeUrl) {
  const baseFormat = 'best[height<=720][ext=mp4]/best[height<=720]/best';
  const hasCookies = Boolean(YTDLP_COOKIES && fsSync.existsSync(YTDLP_COOKIES));
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

// File-based cache configuration
const CACHE_DIR = path.join(__dirname, 'cache');

// Persistent cache class with different TTL for different data types
class PersistentCache {
  constructor() {
    this.youtubeCacheFile = path.join(CACHE_DIR, 'youtube_cache.json');
    this.streamCacheFile = path.join(CACHE_DIR, 'stream_cache.json');
    this.youtubeCache = new Map(); // YouTube URLs - no TTL
    this.streamCache = new Map();  // Stream URLs - with TTL
    this.cleanupInterval = setInterval(() => this.cleanup(), 60 * 60 * 1000); // Clean every hour
    this.loadCache();
  }

  async loadCache() {
    try {
      // Load YouTube cache (permanent)
      if (await this.fileExists(this.youtubeCacheFile)) {
        const data = JSON.parse(await fs.readFile(this.youtubeCacheFile, 'utf8'));
        this.youtubeCache = new Map(Object.entries(data));
      }

      // Load stream cache (with TTL)
      if (await this.fileExists(this.streamCacheFile)) {
        const data = JSON.parse(await fs.readFile(this.streamCacheFile, 'utf8'));
        this.streamCache = new Map(Object.entries(data));
      }
    } catch (error) {
      console.error('Error loading cache:', error);
    }
  }

  async fileExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async saveCache() {
    try {
      // Save YouTube cache
      await fs.writeFile(this.youtubeCacheFile, JSON.stringify(Object.fromEntries(this.youtubeCache), null, 2));

      // Save stream cache
      await fs.writeFile(this.streamCacheFile, JSON.stringify(Object.fromEntries(this.streamCache), null, 2));
    } catch (error) {
      console.error('Error saving cache:', error);
    }
  }

  // Store YouTube URL (no TTL)
  setYouTube(key, value) {
    this.youtubeCache.set(key, { ...value, cached: true, timestamp: new Date().toISOString() });
    this.saveCache();
  }

  // Store streaming URL (with TTL in hours)
  setStream(key, value, ttlHours = 6) {
    const expiresAt = Date.now() + (ttlHours * 60 * 60 * 1000);
    this.streamCache.set(key, {
      ...value,
      cached: true,
      timestamp: new Date().toISOString(),
      expiresAt
    });
    this.saveCache();
  }

  // Get YouTube URL
  getYouTube(key) {
    return this.youtubeCache.get(key);
  }

  // Get streaming URL (check if expired)
  getStream(key) {
    const entry = this.streamCache.get(key);
    if (entry && Date.now() < entry.expiresAt) {
      return entry;
    }
    if (entry) {
      // Remove expired entry
      this.streamCache.delete(key);
      this.saveCache();
    }
    return undefined;
  }

  // Cleanup expired stream URLs
  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, entry] of this.streamCache.entries()) {
      if (now >= entry.expiresAt) {
        this.streamCache.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(`🧹 Cleaned up ${cleaned} expired cache entries`);
      this.saveCache();
    }
  }

  // Get cache stats
  getStats() {
    return {
      youtubeKeys: this.youtubeCache.size,
      streamKeys: this.streamCache.size,
      totalKeys: this.youtubeCache.size + this.streamCache.size
    };
  }

  // Get all keys for debugging
  keys() {
    return [
      ...Array.from(this.youtubeCache.keys()).map(k => `youtube:${k}`),
      ...Array.from(this.streamCache.keys()).map(k => `stream:${k}`)
    ];
  }

  // Flush all cache
  flushAll() {
    this.youtubeCache.clear();
    this.streamCache.clear();
    this.saveCache();
  }
}

const trailerCache = new PersistentCache();

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
  const stats = trailerCache.getStats();
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    cache: {
      totalKeys: stats.totalKeys,
      youtubeKeys: stats.youtubeKeys,
      streamKeys: stats.streamKeys,
      stats: stats
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
    
    // Create cache keys
    const streamCacheKey = tmdbId ? `tmdb_${tmdbId}_${type || 'movie'}` : `search_${title}_${year}`;
    const youtubeCacheKey = tmdbId ? `tmdb_${tmdbId}_${type || 'movie'}_youtube` : `search_${title}_${year}_youtube`;

    // Check streaming URL cache first (with TTL)
    const cachedResult = trailerCache.getStream(streamCacheKey);
    if (cachedResult) {
      console.log(`🎯 Stream cache hit for ${tmdbId ? 'TMDB' : 'search'}: ${title || tmdbId} (${year})`);
      return res.json(cachedResult);
    }
    
    let youtubeUrl = null;
    
    // Check YouTube URL cache first (permanent)
    const cachedYouTubeUrl = trailerCache.getYouTube(youtubeCacheKey);
    if (cachedYouTubeUrl) {
      console.log(`🎯 YouTube cache hit for ${tmdbId ? 'TMDB' : 'search'}: ${title || tmdbId} (${year})`);
      youtubeUrl = cachedYouTubeUrl.youtubeUrl;
    } else {
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

      // Cache the YouTube URL permanently if we found one
      if (youtubeUrl) {
        trailerCache.setYouTube(youtubeCacheKey, {
          youtubeUrl,
          title: title || 'Unknown',
          year: year || 'Unknown',
          source: tmdbId ? 'tmdb' : 'youtube_search'
        });
      }
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

    // Cache the streaming URL with TTL (6 hours default)
    trailerCache.setStream(streamCacheKey, result, 6);
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
    
    // Create cache key for streaming URL
    const streamCacheKey = `trailer_${title}_${year}_${youtube_url}`;

    // Check streaming URL cache first (with TTL)
    const cachedResult = trailerCache.getStream(streamCacheKey);
    if (cachedResult) {
      console.log(`🎯 Stream cache hit for: ${title} (${year})`);
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

    // Cache the streaming URL with TTL (6 hours default)
    trailerCache.setStream(streamCacheKey, result, 6);
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
  const allKeys = trailerCache.keys();
  const cacheData = {};

  // Get all cached data
  allKeys.forEach(key => {
    if (key.startsWith('youtube:')) {
      const actualKey = key.substring(8); // Remove 'youtube:' prefix
      cacheData[key] = trailerCache.getYouTube(actualKey);
    } else if (key.startsWith('stream:')) {
      const actualKey = key.substring(7); // Remove 'stream:' prefix
      cacheData[key] = trailerCache.getStream(actualKey);
    }
  });

  res.json({
    count: allKeys.length,
    keys: allKeys,
    data: cacheData,
    stats: trailerCache.getStats()
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
