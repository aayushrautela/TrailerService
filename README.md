# TrailerService

A lightweight Node.js service that converts YouTube trailer URLs into direct streaming links using yt-dlp. The server provides caching, rate limiting, security headers, and a small HTTP API for integration with client apps.

## Contents
- Overview
- Prerequisites
- Installation
- Configuration
- API
- Testing
- Deployment
- Troubleshooting
- License

## Overview
TrailerService accepts a YouTube URL and returns a direct streaming URL suitable for client applications and media players. It uses yt-dlp to extract stream URLs and an in-memory cache to reduce repeated extraction for the same input.

Features:
- Extracts direct media links from YouTube using yt-dlp
- Caches results (default TTL: 24 hours)
- Rate-limits requests (default: 10 requests/min per IP)
- Adds common security headers (Helmet)
- Health and cache management endpoints

## Prerequisites
- Node.js 16 or newer
- yt-dlp installed and available in the system PATH

Install yt-dlp:
- macOS:
```bash
brew install yt-dlp
```
- Linux / Windows (via pip):
```bash
pip install yt-dlp
```

Verify installation:
```bash
which yt-dlp
```

## Installation
1. Clone the repository and change into it:
```bash
git clone <your-repo-url>
cd TrailerService
```
2. Install dependencies:
```bash
npm install
```
3. Start the server:
```bash
# Development (auto-reload)
npm run dev

# Production
npm start
```

By default the server listens on `http://localhost:3001`.

## Configuration
Environment variables:
- `PORT` — server port (default: `3001`)
- `NODE_ENV` — `development` or `production`

Check the source for additional configuration keys (cache TTL, rate limit values) if you need to customize behavior.

## API
Base URL: `http://localhost:<PORT>` (default `3001`)

GET /health
- Purpose: basic health check
- Example:
```bash
curl http://localhost:3001/health
```
- Example response:
```json
{
  "status": "ok",
  "uptime": 123.45
}
```

GET /trailer
- Purpose: return a direct streaming URL for a YouTube trailer
- Query parameters:
  - `youtube_url` (required) — full YouTube watch URL
  - `title` (optional) — movie/show title (metadata)
  - `year` (optional) — release year (metadata)
- Example:
```bash
curl "http://localhost:3001/trailer?youtube_url=https://www.youtube.com/watch?v=EXAMPLE&title=Avengers&year=2019"
```
- Example response:
```json
{
  "url": "https://direct-streaming-url.example/video.mp4",
  "title": "Avengers",
  "year": "2019",
  "source": "youtube",
  "cached": false,
  "timestamp": "2026-02-23T10:00:00.000Z"
}
```

GET /cache
- Purpose: list cached trailer entries (for debugging)

DELETE /cache
- Purpose: clear the cache

## Usage from a client (example)
Example TypeScript helper that calls the local service:
```typescript
// src/services/trailerService.ts
export class TrailerService {
  private static readonly BASE_URL = 'http://localhost:3001/trailer';

  static async getTrailerUrl(title: string, year: number): Promise<string | null> {
    try {
      // Implement findYouTubeTrailer to locate the YouTube URL
      const youtubeUrl = await this.findYouTubeTrailer(title, year);
      if (!youtubeUrl) return null;

      const response = await fetch(
        `${this.BASE_URL}?youtube_url=${encodeURIComponent(youtubeUrl)}&title=${encodeURIComponent(title)}&year=${year}`
      );
      if (!response.ok) return null;
      const data = await response.json();
      return data.url ?? null;
    } catch (err) {
      console.error('TrailerService error', err);
      return null;
    }
  }

  private static async findYouTubeTrailer(_title: string, _year: number): Promise<string | null> {
    // Placeholder: implement search using YouTube API or a query
    return null;
  }
}
```

## Testing
Run the test suite:
```bash
npm test
```
The tests exercise the health endpoint, trailer extraction, cache behavior, and rate limiting.

## Deployment
- Serverless (Netlify / Vercel): adapt extraction into a serverless function and ensure an extraction mechanism is available at runtime (yt-dlp may not be available in all serverless runtimes).
- Containerized hosting (Railway / Render / Docker): include yt-dlp in the container image and set environment variables accordingly.

## Troubleshooting
- yt-dlp not found: ensure yt-dlp is installed and on PATH (`which yt-dlp`).
- Rate limited: requests are rate-limited per IP — wait or adjust configuration.
- Trailer not found: verify the YouTube URL is correct and the video is accessible in your region.

## Contributing
- Open issues for bugs or feature requests and create pull requests with tests when possible.

## License
MIT

(End)
