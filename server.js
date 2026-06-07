
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



// ── Server-side prompt builder (hidden from client) ───────────────
function buildDesc(d) {
  const lang = d.lang || 'de';
  const sep = {de:['Bj.','Tsd. km'],en:['year','tsd. km'],ru:['г.','тыс.км']};
  const sv = sep[lang] || sep.de;
  return [d.make, d.model,
    d.year   ? `${sv[0]} ${d.year}`    : '',
    d.mileage? `${d.mileage} ${sv[1]}` : '',
    d.body, d.engine, d.trans, d.notes
  ].filter(Boolean).join(', ');
}

function buildPrompt(desc, lang) {
  const today    = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const curYear  = today.getFullYear();

  const role = {
    ru: 'Ты — строгий эксперт по покупке подержанных автомобилей. Указывай только факты в которых абсолютно уверен. Если точно не знаешь — пропускай. Никогда не придумывай цифры, цены и статистику.',
    de: 'Du bist ein strenger Gebrauchtwagen-Experte. Nenne nur Fakten die du sicher kennst. Unbekanntes weglassen. Erfinde niemals Zahlen, Preise oder Reparaturkosten.',
    en: 'You are a strict used-car expert. Only state facts you are certain about. Omit anything uncertain. Never invent numbers, prices, mileage figures or repair costs.'
  };
  const dateNote = {
    ru: `Сегодняшняя дата: ${todayStr}. Возраст авто рассчитывай от ${curYear} года.`,
    de: `Heutiges Datum: ${todayStr}. Fahrzeugalter ab Jahr ${curYear} berechnen.`,
    en: `Today's date: ${todayStr}. Calculate vehicle age from year ${curYear}.`
  };
  const cmd = {
    ru: `Строго по-русски. ${dateNote.ru} Авто: ${desc}`,
    de: `Nur Deutsch. ${dateNote.de} Fahrzeug: ${desc}`,
    en: `English only. ${dateNote.en} Vehicle: ${desc}`
  };

  return `${role[lang]||role.de}\n\n${cmd[lang]||cmd.de}\n\nSTRICT RULES:\n1. NEVER invent specific numbers, mileage figures, repair costs or percentages\n2. Only describe problems genuinely documented for this exact model\n3. If unsure about a fact omit it or describe in general terms only\n4. First verify make+model is a real production car. If not, return ONLY: {"valid":false}\n\nReturn ONLY valid JSON, no markdown:\n{"valid":true,"riskLevel":"low"|"medium"|"high","riskSummary":"2 sentences, no invented numbers","knownIssues":[{"severity":"critical"|"warning"|"ok","title":"short","detail":"problem type only, no invented stats"}],"inspectionChecklist":[{"category":"name","items":["item"]}],"questionsForSeller":["q1","q2","q3","q4","q5","q6"],"redFlags":["f1","f2","f3"],"tip":"1 sentence based on real knowledge"}\nIf valid, return full JSON with "valid":true as first field.\nGive 5 knownIssues, 4 checklist categories (3 items each), 6 questions, 3 red flags.\nAll cost estimates MUST be in EUR (€). Be specific to this exact model.`;
}

// ── Car analysis endpoint (prompt hidden server-side) ─────────────
app.post('/api/analyse-car', dailyLimiter, analysisLimiter, botGuard, async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error:{ message:'Server not configured.' }});

  // Turnstile verification
  const tsToken = req.headers['x-turnstile-token'];
  const tsValid = await verifyTurnstile(tsToken, req.ip);
  if (!tsValid) return res.status(403).json({ error:{ message:'Bot check failed.' }});

  const d    = req.body;
  const lang = d.lang || 'de';
  const desc = buildDesc(d);
  const cacheKey = 'ac:' + desc.toLowerCase().replace(/\s+/g,'_').slice(0,80);

  // Check cache
  const cached = await cacheGet(cacheKey);
  if (cached) {
    res.setHeader('X-Cache','HIT');
    return res.json(cached);
  }

  try {
    const prompt = buildPrompt(desc, lang);
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 4000,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await upstream.json();
    if (upstream.ok && data.content) {
      await cacheSet(cacheKey, data);
      res.setHeader('X-Cache','MISS');
    }
    res.status(upstream.status).json(data);
  } catch(e) {
    res.status(500).json({ error:{ message: e.message }});
  }
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
