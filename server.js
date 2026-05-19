const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const API_KEY = process.env.ANTHROPIC_API_KEY;

// ── Simple in-memory cache ────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

function getCacheKey(body) {
  // Cache only main analysis calls (Sonnet, no tools)
  if (body.tools?.length) return null;
  if (body.model !== 'claude-sonnet-4-5') return null;
  const text = body.messages?.[0]?.content || '';
  // Extract make/model/year from prompt as cache key
  const match = text.match(/Vehicle to analyse:\s*([^\n]+)/i) ||
                text.match(/Авто:\s*([^\n,]+(?:,[^\n,]+){0,3})/i) ||
                text.match(/Fahrzeug:\s*([^\n,]+(?:,[^\n,]+){0,3})/i);
  if (!match) return null;
  return match[1].trim().toLowerCase().replace(/\s+/g, '_').slice(0, 80);
}

function cleanCache() {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (now - entry.ts > CACHE_TTL) cache.delete(key);
  }
}

// Clean cache every hour
setInterval(cleanCache, 60 * 60 * 1000);

// ── Proxy endpoint ────────────────────────────────────────────────
app.post('/api/analyse', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY not configured.' } });
  }

  // Check cache
  const cacheKey = getCacheKey(req.body);
  if (cacheKey && cache.has(cacheKey)) {
    const entry = cache.get(cacheKey);
    if (Date.now() - entry.ts < CACHE_TTL) {
      console.log(`Cache hit: ${cacheKey}`);
      res.setHeader('X-Cache', 'HIT');
      return res.json(entry.data);
    }
  }

  try {
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01'
    };
    if (req.body.tools?.some(t => t.type?.includes('web_search'))) {
      headers['anthropic-beta'] = 'web-search-2025-03-05';
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body)
    });

    const data = await response.json();

    // Store in cache if successful main analysis
    if (response.ok && cacheKey && data.content) {
      cache.set(cacheKey, { data, ts: Date.now() });
      console.log(`Cached: ${cacheKey} (cache size: ${cache.size})`);
      res.setHeader('X-Cache', 'MISS');
    }

    res.status(response.status).json(data);
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

// Cache stats endpoint (useful for monitoring)
app.get('/api/cache-stats', (req, res) => {
  res.json({ size: cache.size, keys: [...cache.keys()] });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AutoCheck AI running on port ${PORT}`));
