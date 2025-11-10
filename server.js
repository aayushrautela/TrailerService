const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
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
  // Prioritize 4K (2160p), fallback to best available quality
  const baseFormat = 'best[height<=2160]/best';
  // Check for cookies in multiple locations
  const hasCookies = Boolean(
    (YTDLP_COOKIES && fsSync.existsSync(YTDLP_COOKIES)) ||
    fsSync.existsSync(path.join(__dirname, 'cookies.txt'))
  );
  const cookiesArg = hasCookies
    ? ` --cookies "${YTDLP_COOKIES || path.join(__dirname, 'cookies.txt')}"`
    : '';
  // If cookies are present, prefer them and avoid forcing an extractor client that may ignore cookies
  const extractorArgs = !hasCookies && YTDLP_EXTRACTOR_ARGS
    ? ` --extractor-args "${YTDLP_EXTRACTOR_ARGS}"`
    : '';
  return `yt-dlp -f "${baseFormat}" -g --no-playlist${cookiesArg}${extractorArgs} "${youtubeUrl}"`;
}

// TMDB API configuration
const TMDB_API_KEY = process.env.TMDB_API_KEY || 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI0MzljNDc4YTc3MWYzNWMwNTAyMmY5ZmVhYmNjYTAxYyIsIm5iZiI6MTcwOTkxMTEzNS4xNCwic3ViIjoiNjVlYjJjNWYzODlkYTEwMTYyZDgyOWU0Iiwic2NvcGVzIjpbImFwaV9yZWFkIl0sInZlcnNpb24iOjF9.gosBVl1wYUbePOeB9WieHn8bY9x938-GSGmlXZK_UVM';
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

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Function to execute yt-dlp search for music
async function searchYouTubeMusic(query, maxResults = 10, type = 'all') {
  try {
    // Modify query based on type preference
    let searchQuery = query;
    if (type === 'musicvideo') {
      // Add "music video" to prioritize music videos
      searchQuery = `${query} music video`;
    }

    // Create cache key
    const cacheKey = `music_search_${query}_${type}_${maxResults}`;

    // Check cache first
    const cachedResult = trailerCache.getStream(cacheKey);
    if (cachedResult) {
      console.log(`[CACHE] HIT: music search for "${query}"`);
      return cachedResult.results;
    }

    // Using yt-dlp to search YouTube
    const command = `yt-dlp --cookies ${__dirname}/cookies.txt "ytsearch${maxResults}:${searchQuery}" --dump-json --skip-download --no-warnings --flat-playlist`;

    const { stdout } = await execAsync(command, { maxBuffer: 1024 * 1024 * 10 });

    // Parse the JSON output (each line is a separate JSON object)
    const results = stdout
      .trim()
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try {
          return JSON.parse(line);
        } catch (e) {
          console.error('Error parsing line:', e);
          return null;
        }
      })
      .filter(item => item !== null)
      .map(item => {
        // Get the best quality thumbnail from the array
        let bestThumbnail = item.thumbnail || item.thumbnails?.[0]?.url || '';
        if (item.thumbnails && item.thumbnails.length > 0) {
          // Sort by size and get the largest (optimized for performance)
          if (item.thumbnails.length > 50) {
            // Parallel processing for large arrays
            const processed = item.thumbnails.map(thumb => ({
              ...thumb,
              size: (thumb.width || 0) * (thumb.height || 0)
            })).sort((a, b) => b.size - a.size);
            bestThumbnail = processed[0].url;
          } else {
            // Synchronous processing for smaller arrays
            const sorted = item.thumbnails.sort((a, b) => {
              const sizeA = (a.width || 0) * (a.height || 0);
              const sizeB = (b.width || 0) * (b.height || 0);
              return sizeB - sizeA;
            });
            bestThumbnail = sorted[0].url;
          }
        }

        return {
          id: item.id,
          title: item.title,
          artist: item.uploader || item.channel || 'Unknown Artist',
          duration: item.duration,
          thumbnail: bestThumbnail,
          url: item.url || `https://www.youtube.com/watch?v=${item.id}`,
          type: 'Song',
        };
      });

    // Cache the results for 1 hour
    trailerCache.setStream(cacheKey, { results }, 1);

    return results;
  } catch (error) {
    console.error('Error searching YouTube for music:', error);
    throw error;
  }
}

// Function to get music video info
async function getMusicVideoInfo(videoId) {
  try {
    // Check cache first
    const cacheKey = `music_video_${videoId}`;
    const cachedInfo = trailerCache.getStream(cacheKey);
    if (cachedInfo) {
      return cachedInfo;
    }

    const command = `yt-dlp --cookies ${__dirname}/cookies.txt "https://www.youtube.com/watch?v=${videoId}" --dump-json --skip-download --no-warnings`;

    const { stdout } = await execAsync(command);
    const videoData = JSON.parse(stdout);

    // Try to get audio/music thumbnail first (metadata)
    let highQualityThumbnail = videoData.thumbnail || '';

    // Check for audio/music metadata thumbnails (usually better quality for music)
    if (videoData.ext === 'm4a' || videoData.ext === 'mp3' || videoData.uploader_url?.includes('music')) {
      highQualityThumbnail = videoData.thumbnail || '';
    }

    // Sort thumbnails by quality (width * height) - parallel processing
    if (videoData.thumbnails && videoData.thumbnails.length > 0) {
      // Use parallel processing for large thumbnail arrays (>50 thumbnails)
      const shouldProcessParallel = videoData.thumbnails.length > 50;

      let sorted;
      if (shouldProcessParallel) {
        // For large arrays, process in chunks to avoid blocking
        const chunkSize = 10;
        const chunks = [];
        for (let i = 0; i < videoData.thumbnails.length; i += chunkSize) {
          chunks.push(videoData.thumbnails.slice(i, i + chunkSize));
        }

        // Process chunks in parallel to calculate sizes
        const processedChunks = await Promise.all(
          chunks.map(async (chunk) => {
            return chunk.map(thumb => ({
              ...thumb,
              size: (thumb.width || 0) * (thumb.height || 0)
            }));
          })
        );

        // Flatten and sort
        const allProcessed = processedChunks.flat();
        sorted = allProcessed.sort((a, b) => b.size - a.size);
      } else {
        // For smaller arrays, use synchronous processing
        sorted = videoData.thumbnails
          .map(thumb => ({
            ...thumb,
            size: (thumb.width || 0) * (thumb.height || 0)
          }))
          .sort((a, b) => b.size - a.size);
      }

      // Use the highest quality thumbnail
      highQualityThumbnail = sorted[0].url;

      console.log(`Available thumbnails: ${videoData.thumbnails.length}`);
      console.log(`Selected thumbnail size: ${sorted[0].width}x${sorted[0].height}`);
    }

    const videoInfo = {
      id: videoData.id,
      title: videoData.title,
      artist: videoData.uploader || videoData.channel || 'Unknown Artist',
      duration: videoData.duration,
      thumbnail: highQualityThumbnail,
      thumbnails: videoData.thumbnails || [],
      description: videoData.description,
      url: videoData.url,
      formats: videoData.formats,
    };

    // Cache the video info for 6 hours
    trailerCache.setStream(cacheKey, videoInfo, 6);

    return videoInfo;
  } catch (error) {
    console.error('Error getting music video info:', error);
    throw error;
  }
}

// Function to get m3u8 HLS URL for music streaming (minimal, no thumbnail processing)
async function getMusicAudioUrl(videoId) {
  try {
    // Check cache first
    const cacheKey = `music_audio_${videoId}`;
    const cachedUrl = trailerCache.getStream(cacheKey);
    if (cachedUrl) {
      return cachedUrl.audioUrl;
    }

    // Use m3u8 HLS format for better compatibility
    // Get format 93 which provides m3u8 HLS playlist
    let command = `yt-dlp --cookies ${__dirname}/cookies.txt -f 93 -g "https://www.youtube.com/watch?v=${videoId}" 2>&1 | tail -1`;

    console.log('Getting m3u8 URL for music video:', videoId);
    const { stdout, stderr } = await execAsync(command, { timeout: 30000 });

    const audioUrl = stdout.trim();

    if (!audioUrl) {
      throw new Error('No m3u8 URL returned from yt-dlp');
    }

    console.log('Got m3u8 URL, length:', audioUrl.length);

    // Cache the URL for 3 hours
    trailerCache.setStream(cacheKey, { audioUrl }, 3);

    return audioUrl;
  } catch (error) {
    console.error('Error getting m3u8 URL:', error);
    throw error;
  }
}

// Function to get minimal video info for manifest (no thumbnail processing)
async function getMinimalVideoInfo(videoId) {
  try {
    // Check cache first
    const cacheKey = `music_video_minimal_${videoId}`;
    const cachedInfo = trailerCache.getStream(cacheKey);
    if (cachedInfo) {
      return cachedInfo;
    }

    // Get only essential info without thumbnail processing
    const command = `yt-dlp --cookies ${__dirname}/cookies.txt --print "%(title)s|||%(uploader)s|||%(thumbnail)s" --skip-download --no-warnings "https://www.youtube.com/watch?v=${videoId}"`;

    const { stdout } = await execAsync(command);

    const [title, uploader, thumbnail] = stdout.trim().split('|||');

    const videoInfo = {
      id: videoId,
      title: title || 'Unknown Title',
      artist: uploader || 'Unknown Artist',
      thumbnail: thumbnail || '',
    };

    // Cache the minimal info for 6 hours
    trailerCache.setStream(cacheKey, videoInfo, 6);

    return videoInfo;
  } catch (error) {
    console.error('Error getting minimal video info:', error);
    throw error;
  }
}

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
app.get('/search-trailer', async (req, res) => {
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
app.get('/trailer', async (req, res) => {
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
    // Prioritizes best quality up to 4K (2160p)
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

// FiDily Music API Endpoints

// Root endpoint for FiDily service
app.get('/', (req, res) => {
  res.json({
    message: 'FiDily Music Server is running!',
    version: '1.0.0',
    endpoints: {
      search: '/api/search?q=query&limit=10&type=all',
      videoInfo: '/api/video/:videoId',
      audioStream: '/api/audio/:videoId'
    }
  });
});

// Music search endpoint
app.get('/api/search', async (req, res) => {
  try {
    const { q, limit = 10, type = 'all' } = req.query;

    if (!q) {
      return res.status(400).json({ error: 'Search query is required' });
    }
    console.log(`Searching for music: ${q} (type: ${type})`);
    const results = await searchYouTubeMusic(q, limit, type);

    res.json({
      success: true,
      query: q,
      type: type,
      count: results.length,
      results: results,
    });
  } catch (error) {
    console.error('Music search error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to search',
      message: error.message
    });
  }
});

// Get music video info endpoint
app.get('/api/video/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;

    console.log(`Getting music video info for: ${videoId}`);
    const videoInfo = await getMusicVideoInfo(videoId);

    res.json({
      success: true,
      video: videoInfo,
    });
  } catch (error) {
    console.error('Music video info error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get video info',
      message: error.message
    });
  }
});

// Get music audio URL endpoint with minimal metadata (no thumbnail processing)
app.get('/api/audio/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;

    console.log(`Getting m3u8 URL and minimal metadata for music video: ${videoId}`);
    const [audioUrl, videoInfo] = await Promise.all([
      getMusicAudioUrl(videoId),
      getMinimalVideoInfo(videoId)
    ]);

    res.json({
      success: true,
      videoId: videoId,
      audioUrl: audioUrl,
      format: 'application/vnd.apple.mpegurl',
      type: 'hls',
      description: 'HLS/m3u8 playlist for audio streaming',
      // Include artwork from minimal processing
      artwork: videoInfo.thumbnail,
      title: videoInfo.title,
      artist: videoInfo.artist,
    });
  } catch (error) {
    console.error('Music audio URL error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get audio URL',
      message: error.message
    });
  }
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
