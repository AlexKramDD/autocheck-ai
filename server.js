const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const API_KEY        = process.env.ANTHROPIC_API_KEY;
const UPSTASH_URL    = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN  = process.env.UPSTASH_REDIS_REST_TOKEN;
const CACHE_TTL_SEC  = 24 * 60 * 60;

// In-memory fallback
const memCache = new Map();
setInterval(() => {
  const exp = Date.now() - CACHE_TTL_SEC * 1000;
  for (const [k,v] of memCache.entries()) if (v.ts < exp) memCache.delete(k);
}, 60 * 60 * 1000);

// Upstash REST
async function redisCmd(...args) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  try {
    const r = await fetch(UPSTASH_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args)
    });
    return (await r.json()).result ?? null;
  } catch { return null; }
}

async function cacheGet(key) {
  if (UPSTASH_URL) {
    const val = await redisCmd('GET', key);
    if (val) { memCache.set(key, { data: JSON.parse(val), ts: Date.now() }); return JSON.parse(val); }
  }
  const e = memCache.get(key);
  if (e && Date.now() - e.ts < CACHE_TTL_SEC * 1000) return e.data;
  return null;
}

async function cacheSet(key, value) {
  memCache.set(key, { data: value, ts: Date.now() });
  if (UPSTASH_URL) await redisCmd('SET', key, JSON.stringify(value), 'EX', CACHE_TTL_SEC);
}

function getCacheKey(body) {
  if (body.tools?.length) return null;
  if (body.model !== 'claude-sonnet-4-5') return null;
  const text = body.messages?.[0]?.content || '';
  const m = text.match(/Vehicle to analyse:\s*([^\n]+)/i)
         || text.match(/Авто:\s*([^\n,]+(?:,[^\n,]+){0,3})/i)
         || text.match(/Fahrzeug:\s*([^\n,]+(?:,[^\n,]+){0,3})/i);
  if (!m) return null;
  return 'ac:' + m[1].trim().toLowerCase().replace(/\s+/g,'_').slice(0,80);
}

app.post('/api/analyse', async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error:{ message:'ANTHROPIC_API_KEY not set.' }});

  const key = getCacheKey(req.body);
  if (key) {
    const cached = await cacheGet(key);
    if (cached) {
      console.log(`HIT  [${UPSTASH_URL?'Redis':'Mem'}] ${key}`);
      res.setHeader('X-Cache','HIT');
      return res.json(cached);
    }
  }

  try {
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01'
    };
    if (req.body.tools?.some(t => t.type?.includes('web_search')))
      headers['anthropic-beta'] = 'web-search-2025-03-05';

    const upstream = await fetch('https://api.anthropic.com/v1/messages',
      { method:'POST', headers, body: JSON.stringify(req.body) });
    const data = await upstream.json();

    if (upstream.ok && key && data.content) {
      await cacheSet(key, data);
      console.log(`MISS [${UPSTASH_URL?'Redis':'Mem'}] ${key}`);
      res.setHeader('X-Cache','MISS');
    }

    res.status(upstream.status).json(data);
  } catch(e) {
    res.status(500).json({ error:{ message: e.message }});
  }
});

app.get('/api/cache-stats', (req, res) => res.json({
  backend: UPSTASH_URL ? 'Redis (Upstash)' : 'Memory only',
  memEntries: memCache.size
}));

app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname,'public','index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AutoCheck AI — port ${PORT}`);
  console.log(`Cache: ${UPSTASH_URL ? 'Redis (Upstash)' : 'Memory only'}`);
});
