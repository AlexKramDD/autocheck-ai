
const express    = require('express');
const rateLimit  = require('express-rate-limit');
const path       = require('path');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

// ── Basic Auth (temporary protection) ────────────────────────────
function basicAuth(req, res, next) {
  const user = process.env.BASIC_USER;
  const pass = process.env.BASIC_PASS;
  if (!user || !pass) return next(); // disabled if not configured
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Basic ')) {
    const [u, p] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
    if (u === user && p === pass) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="AutoCheck AI"');
  res.status(401).send('Login required');
}
app.use(basicAuth);
app.use(express.static(path.join(__dirname, 'public')));

const API_KEY             = process.env.ANTHROPIC_API_KEY;
const UPSTASH_URL         = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN       = process.env.UPSTASH_REDIS_REST_TOKEN;
const TURNSTILE_SITE_KEY  = process.env.TURNSTILE_SITE_KEY;
const TURNSTILE_SECRET    = process.env.TURNSTILE_SECRET_KEY;
const CACHE_TTL_SEC       = 24 * 60 * 60;

// ── Cache ─────────────────────────────────────────────────────────
const memCache = new Map();
setInterval(() => {
  const exp = Date.now() - CACHE_TTL_SEC * 1000;
  for (const [k,v] of memCache.entries()) if (v.ts < exp) memCache.delete(k);
}, 60 * 60 * 1000);

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

// ── Turnstile verification ────────────────────────────────────────
async function verifyTurnstile(token, ip) {
  if (!TURNSTILE_SECRET) return true; // not configured = skip
  if (!token) return false;
  try {
    const form = new URLSearchParams();
    form.append('secret', TURNSTILE_SECRET);
    form.append('response', token);
    if (ip) form.append('remoteip', ip);
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form
    });
    const data = await r.json();
    return data.success === true;
  } catch { return true; } // on network error — allow through
}

// ── Rate limiters ─────────────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60,
  standardHeaders: true, legacyHeaders: false,
  message: { error: { message: 'Too many requests — please wait a minute.' } }
});
const analysisLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 8,
  standardHeaders: true, legacyHeaders: false,
  message: { error: { message: 'Rate limit reached — please wait 15 minutes.' } }
});
const dailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, max: 30,
  standardHeaders: true, legacyHeaders: false,
  message: { error: { message: 'Daily limit reached for this IP. Try again tomorrow.' } }
});

app.use(generalLimiter);

// ── Bot detection ─────────────────────────────────────────────────
function botGuard(req, res, next) {
  const ua = req.headers['user-agent'] || '';
  if (/^(curl|python-requests|go-http|wget|scrapy|libwww)/i.test(ua))
    return res.status(403).json({ error: { message: 'Automated requests not allowed.' } });
  if (!req.body?.model || !req.body?.messages)
    return res.status(400).json({ error: { message: 'Invalid request.' } });
  next();
}

// ── Config endpoint (exposes public keys to frontend) ─────────────
app.get('/api/config', (req, res) => {
  res.json({ turnstileSiteKey: TURNSTILE_SITE_KEY || null });
});

// ── Main analysis endpoint ────────────────────────────────────────
app.post('/api/analyse', dailyLimiter, analysisLimiter, botGuard, async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error: { message: 'Server not configured.' }});

  // Turnstile verification
  const tsToken = req.headers['x-turnstile-token'];
  const tsValid = await verifyTurnstile(tsToken, req.ip);
  if (!tsValid) {
    return res.status(403).json({ error: { message: 'Bot check failed. Please refresh and try again.' }});
  }

  // Cache check
  const key = getCacheKey(req.body);
  if (key) {
    const cached = await cacheGet(key);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
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
      { method: 'POST', headers, body: JSON.stringify(req.body) });
    const data = await upstream.json();

    if (upstream.ok && key && data.content) {
      await cacheSet(key, data);
      res.setHeader('X-Cache', 'MISS');
    }

    res.status(upstream.status).json(data);
  } catch(e) {
    res.status(500).json({ error: { message: e.message }});
  }
});

// ── Stats ─────────────────────────────────────────────────────────
app.get('/api/cache-stats', (req, res) => {
  if (req.query.key !== process.env.STATS_KEY) return res.status(403).end();
  res.json({ backend: UPSTASH_URL ? 'Redis' : 'Memory', memEntries: memCache.size });
});


// ── Legal pages ───────────────────────────────────────────────────
app.get('/impressum',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'impressum.html')));
app.get('/datenschutz', (req, res) => res.sendFile(path.join(__dirname, 'public', 'datenschutz.html')));
app.get('/agb',         (req, res) => res.sendFile(path.join(__dirname, 'public', 'agb.html')));

app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AutoCheck AI — port ${PORT}`);
  console.log(`Cache:     ${UPSTASH_URL ? 'Redis (Upstash)' : 'Memory only'}`);
  console.log(`Turnstile: ${TURNSTILE_SECRET ? 'Enabled' : 'Disabled (set TURNSTILE_SECRET_KEY)'}`);
});
