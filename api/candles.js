// Candle history endpoint with layered upstream strategies for resilience.
// Yahoo Finance hard-rate-limits Vercel datacenter IPs (HTTP 429), so we lead
// with Twelve Data (a CDN-style provider that does NOT block datacenter IPs)
// when an API key is configured, and fall through to Yahoo + Stooq as backups.
//
//   1. Twelve Data         — if TWELVE_DATA_KEY is set. Covers all TFs.
//   2. Yahoo (no auth)     — free but datacenter-blocked.
//   3. Yahoo (with crumb)  — same blocking, last-ditch.
//   4. Stooq CSV           — rock-solid for daily; no intraday.
//
// On total upstream failure, returns the last-known-good cached payload (up to
// 1 hour stale) tagged with `stale:true`, so the user keeps seeing a chart.
//
// Response on success: { s:'ok', src, version, t, o, h, l, c, v }
// Response on failure: { s:'no_data', error, tried:[{src,...}], version }

const VERSION = 'multi-strategy-v2-2026-05-06';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

let _crumb = null;
let _cookie = null;
let _crumbTs = 0;
const CRUMB_TTL = 50 * 60 * 1000;

const FETCH_TIMEOUT_MS = 8000;

const FRESH_TTL = 60 * 1000;
const STALE_TTL = 60 * 60 * 1000;
const _cache = new Map();

function cacheKey(symbol, interval, range) { return `${symbol}|${interval}|${range}`; }

function cacheGet(key, allowStale) {
  const e = _cache.get(key);
  if (!e) return null;
  const age = Date.now() - e.ts;
  if (age <= FRESH_TTL) return { ...e, kind: 'fresh', age };
  if (allowStale && age <= STALE_TTL) return { ...e, kind: 'stale', age };
  return null;
}

function cacheSet(key, data) {
  _cache.set(key, { data, ts: Date.now() });
  if (_cache.size > 60) _cache.delete(_cache.keys().next().value);
}

async function timedFetch(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

const TD_INTERVAL = {
  '1m': '1min', '2m': '1min', '5m': '5min', '15m': '15min', '30m': '30min',
  '60m': '1h',  '90m': '1h',  '1h':  '1h',
  '1d': '1day', '5d': '1day', '1wk': '1week', '1mo': '1month', '3mo': '1month',
};

const TD_OUTPUTSIZE = {
  '1d': 100, '5d': 500, '1mo': 800, '3mo': 800, '6mo': 200,
  '1y': 300, '2y': 600, '5y': 1500, '10y': 3000, 'ytd': 300, 'max': 5000,
};

async function tryTwelveData(symbol, interval, range, apiKey) {
  if (!apiKey) return { ok: false, error: 'TWELVE_DATA_KEY not configured' };

  const tdInterval = TD_INTERVAL[interval] || '5min';
  const outputsize = TD_OUTPUTSIZE[range]   || 500;

  const params = new URLSearchParams({
    symbol, interval: tdInterval,
    outputsize: String(outputsize),
    timezone: 'UTC',
    apikey: apiKey,
  });
  const url = `https://api.twelvedata.com/time_series?${params}`;

  const res = await timedFetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: `HTTP ${res.status}`, detail: body.slice(0, 200) };
  }

  let json;
  try { json = await res.json(); }
  catch (_) { return { ok: false, status: 200, error: 'non-JSON response' }; }

  if (json.status === 'error' || json.code) {
    return { ok: false, status: 200,
             error: json.message || `TD code ${json.code}`,
             detail: JSON.stringify(json).slice(0, 200) };
  }
  if (!Array.isArray(json.values) || !json.values.length) {
    return { ok: false, status: 200, error: 'empty values[]' };
  }

  const out = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (let i = json.values.length - 1; i >= 0; i--) {
    const v = json.values[i];
    const t = Math.floor(new Date(v.datetime.replace(' ', 'T') + 'Z').getTime() / 1000);
    const o = +v.open, h = +v.high, l = +v.low, c = +v.close;
    if (!isFinite(o) || !isFinite(h) || !isFinite(l) || !isFinite(c) || !isFinite(t)) continue;
    out.t.push(t); out.o.push(o); out.h.push(h); out.l.push(l); out.c.push(c);
    out.v.push(v.volume ? +v.volume : 0);
  }
  if (out.t.length === 0) return { ok: false, status: 200, error: 'no valid bars' };
  return { ok: true, ...out };
}

function readCookies(headers) {
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  }
  const raw = headers.get('set-cookie') || '';
  return raw.split(/,(?=\s*\w+=)/).map(c => c.split(';')[0]).join('; ');
}

async function fetchCrumb() {
  const consentRes = await timedFetch('https://fc.yahoo.com/', {
    headers: { 'User-Agent': UA, 'Accept': '*/*' }, redirect: 'follow',
  });
  const cookie = readCookies(consentRes.headers);
  if (!cookie) throw new Error('no Set-Cookie from fc.yahoo.com');

  const crumbRes = await timedFetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, 'Accept': 'text/plain, */*', 'Cookie': cookie },
  });
  if (!crumbRes.ok) {
    const body = await crumbRes.text().catch(() => '');
    throw new Error(`getcrumb HTTP ${crumbRes.status}: ${body.slice(0, 160)}`);
  }
  const crumb = (await crumbRes.text()).trim();
  if (!crumb || crumb.length < 3 || crumb.startsWith('<')) {
    throw new Error(`bad crumb body: ${crumb.slice(0, 60)}`);
  }
  return { crumb, cookie };
}

async function getAuth(forceRefresh = false) {
  if (!forceRefresh && _crumb && (Date.now() - _crumbTs) < CRUMB_TTL) {
    return { crumb: _crumb, cookie: _cookie };
  }
  const a = await fetchCrumb();
  _crumb = a.crumb; _cookie = a.cookie; _crumbTs = Date.now();
  return a;
}

function parseYahooJson(json) {
  const result = json?.chart?.result?.[0];
  if (!result || !Array.isArray(result.timestamp)) {
    const yErr = json?.chart?.error;
    return { ok: false, error: 'empty Yahoo response',
             detail: yErr ? (yErr.description || yErr.code) : 'no result[]' };
  }
  const ts = result.timestamp;
  const q = result.indicators?.quote?.[0];
  if (!q) return { ok: false, error: 'missing quote indicators' };

  const out = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    out.t.push(ts[i]);
    out.o.push(+o); out.h.push(+h); out.l.push(+l); out.c.push(+c);
    out.v.push(q.volume?.[i] != null ? +q.volume[i] : 0);
  }
  if (out.t.length === 0) return { ok: false, error: 'all bars filtered (null OHLC)' };
  return { ok: true, ...out };
}

async function tryYahoo(symbol, interval, range, withCrumb) {
  const params = new URLSearchParams({
    interval, range, includePrePost: 'false', events: 'div,split',
  });
  const headers = { 'User-Agent': UA, 'Accept': 'application/json, */*' };

  if (withCrumb) {
    const auth = await getAuth();
    params.set('crumb', auth.crumb);
    headers.Cookie = auth.cookie;
  }

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`;
  const res = await timedFetch(url, { headers });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: `HTTP ${res.status}`, detail: body.slice(0, 200) };
  }

  let json;
  try { json = await res.json(); }
  catch (_) { return { ok: false, status: 200, error: 'non-JSON response' }; }

  const parsed = parseYahooJson(json);
  if (!parsed.ok) return { ok: false, status: 200, ...parsed };
  return parsed;
}

async function tryStooq(symbol, range) {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol.toLowerCase())}.us&i=d`;
  const res = await timedFetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/csv, */*' },
  });
  if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };

  const csv = await res.text();
  if (!csv || csv.startsWith('<') || csv.length < 30) {
    return { ok: false, status: 200, error: 'non-CSV response', detail: csv.slice(0, 120) };
  }

  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return { ok: false, status: 200, error: 'empty CSV' };

  const all = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 5) continue;
    const o = +cols[1], h = +cols[2], l = +cols[3], c = +cols[4];
    const v = cols[5] ? +cols[5] : 0;
    if (!isFinite(o) || !isFinite(h) || !isFinite(l) || !isFinite(c)) continue;
    const t = Math.floor(new Date(cols[0] + 'T20:00:00Z').getTime() / 1000);
    all.t.push(t); all.o.push(o); all.h.push(h);
    all.l.push(l); all.c.push(c); all.v.push(v);
  }
  if (all.t.length === 0) return { ok: false, status: 200, error: 'no valid CSV rows' };

  const RANGE_DAYS = {
    '1d': 5, '5d': 10, '1mo': 32, '3mo': 95, '6mo': 190,
    '1y': 370, '2y': 740, '5y': 1830, '10y': 3660, 'ytd': 366, 'max': 99999,
  };
  const days = RANGE_DAYS[range] ?? 370;
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  let idx = all.t.findIndex(t => t >= cutoff);
  if (idx < 0) idx = Math.max(0, all.t.length - 252);
  if (idx === 0) return { ok: true, ...all };
  return {
    ok: true,
    t: all.t.slice(idx), o: all.o.slice(idx), h: all.h.slice(idx),
    l: all.l.slice(idx), c: all.c.slice(idx), v: all.v.slice(idx),
  };
}

const DAILY_INTERVALS = new Set(['1d', '5d', '1wk', '1mo', '3mo']);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.query.ping) {
    return res.status(200).json({
      s: 'ok',
      version: VERSION,
      ts: Date.now(),
      twelveDataConfigured: !!process.env.TWELVE_DATA_KEY,
      cacheSize: _cache.size,
    });
  }

  const symbol = (req.query.symbol || 'GLD').trim().toUpperCase();
  const ALLOWED = new Set(['GLD', 'QQQ', 'SPY']);
  if (!ALLOWED.has(symbol)) {
    return res.status(400).json({ s: 'no_data', error: `Symbol "${symbol}" not supported`, version: VERSION });
  }

  const interval = (req.query.interval || '5m').trim();
  const range    = (req.query.range    || '5d').trim();
  const VALID_INT = new Set(['1m','2m','5m','15m','30m','60m','90m','1h','1d','5d','1wk','1mo','3mo']);
  const VALID_RNG = new Set(['1d','5d','1mo','3mo','6mo','1y','2y','5y','10y','ytd','max']);
  if (!VALID_INT.has(interval)) return res.status(400).json({ s: 'no_data', error: `Invalid interval "${interval}"`, version: VERSION });
  if (!VALID_RNG.has(range))    return res.status(400).json({ s: 'no_data', error: `Invalid range "${range}"`,       version: VERSION });

  const key = cacheKey(symbol, interval, range);

  const fresh = cacheGet(key, false);
  if (fresh) {
    return res.status(200).json({ ...fresh.data, cache: 'fresh', cacheAge: fresh.age, version: VERSION });
  }

  const tdKey = process.env.TWELVE_DATA_KEY;
  const tried = [];

  if (tdKey) {
    try {
      const r = await tryTwelveData(symbol, interval, range, tdKey);
      if (r.ok) {
        const payload = { s: 'ok', src: 'twelvedata', t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v };
        cacheSet(key, payload);
        return res.status(200).json({ ...payload, version: VERSION });
      }
      tried.push({ src: 'twelvedata', status: r.status, error: r.error, detail: r.detail });
    } catch (e) {
      tried.push({ src: 'twelvedata', error: String(e.message || e).slice(0, 200) });
    }
  } else {
    tried.push({ src: 'twelvedata', skipped: 'TWELVE_DATA_KEY not set in Vercel env' });
  }

  try {
    const r = await tryYahoo(symbol, interval, range, false);
    if (r.ok) {
      const payload = { s: 'ok', src: 'yahoo', t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v };
      cacheSet(key, payload);
      return res.status(200).json({ ...payload, version: VERSION });
    }
    tried.push({ src: 'yahoo', status: r.status, error: r.error, detail: r.detail });

    if (r.status !== 429) {
      try {
        const r2 = await tryYahoo(symbol, interval, range, true);
        if (r2.ok) {
          const payload = { s: 'ok', src: 'yahoo-crumb', t: r2.t, o: r2.o, h: r2.h, l: r2.l, c: r2.c, v: r2.v };
          cacheSet(key, payload);
          return res.status(200).json({ ...payload, version: VERSION });
        }
        tried.push({ src: 'yahoo-crumb', status: r2.status, error: r2.error, detail: r2.detail });
      } catch (e) {
        tried.push({ src: 'yahoo-crumb', error: String(e.message || e).slice(0, 200) });
      }
    } else {
      tried.push({ src: 'yahoo-crumb', skipped: 'shared 429 rate limit' });
    }
  } catch (e) {
    tried.push({ src: 'yahoo', error: String(e.message || e).slice(0, 200) });
  }

  if (DAILY_INTERVALS.has(interval)) {
    try {
      const r = await tryStooq(symbol, range);
      if (r.ok) {
        const payload = { s: 'ok', src: 'stooq', t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v };
        cacheSet(key, payload);
        return res.status(200).json({ ...payload, version: VERSION });
      }
      tried.push({ src: 'stooq', status: r.status, error: r.error, detail: r.detail });
    } catch (e) {
      tried.push({ src: 'stooq', error: String(e.message || e).slice(0, 200) });
    }
  } else {
    tried.push({ src: 'stooq', skipped: 'intraday not supported' });
  }

  const stale = cacheGet(key, true);
  if (stale && stale.kind === 'stale') {
    return res.status(200).json({
      ...stale.data,
      stale: true,
      cacheAge: stale.age,
      version: VERSION,
      warning: 'serving stale cache; all live sources failed',
      tried,
    });
  }

  return res.status(502).json({
    s: 'no_data',
    error: 'All upstream sources failed',
    tried,
    version: VERSION,
  });
}
