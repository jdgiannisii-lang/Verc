// Candle history endpoint with layered upstream strategies for resilience.
// Tries each source in order; first success wins. Failures are reported with
// per-source detail so the frontend can surface a meaningful error.
//
//   1. Yahoo Finance v8 chart API, no auth (works most of the time).
//   2. Yahoo Finance v8 chart API, with crumb cookie auth.
//   3. Stooq CSV daily fallback (only useful for daily timeframes).
//
// Response on success: { s:'ok', src, version, t, o, h, l, c, v }
// Response on failure: { s:'no_data', error, tried:[{src,status,error,detail}], version }

const VERSION = 'multi-strategy-v1-2026-05-06';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

// Module-scope crumb cache — survives across warm invocations.
let _crumb = null;
let _cookie = null;
let _crumbTs = 0;
const CRUMB_TTL = 50 * 60 * 1000;

// Per-request timeout to avoid hanging Vercel functions on slow upstreams.
const FETCH_TIMEOUT_MS = 8000;

async function timedFetch(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
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
    headers: { 'User-Agent': UA, 'Accept': '*/*' },
    redirect: 'follow',
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
    interval, range,
    includePrePost: 'false',
    events: 'div,split',
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
    return { ok: false, status: res.status,
             error: `HTTP ${res.status}`, detail: body.slice(0, 200) };
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
    return { ok: false, status: 200, error: 'non-CSV response',
             detail: csv.slice(0, 120) };
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
    return res.status(200).json({ s: 'ok', version: VERSION, ts: Date.now() });
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

  const tried = [];

  // Strategy 1 — Yahoo, no auth.
  try {
    const r = await tryYahoo(symbol, interval, range, false);
    if (r.ok) {
      return res.status(200).json({ s: 'ok', src: 'yahoo', version: VERSION,
        t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v });
    }
    tried.push({ src: 'yahoo', status: r.status, error: r.error, detail: r.detail });
  } catch (e) {
    tried.push({ src: 'yahoo', error: String(e.message || e).slice(0, 200) });
  }

  // Strategy 2 — Yahoo with crumb. Retry once with fresh crumb on 401/403.
  for (const attempt of ['cached', 'fresh']) {
    try {
      if (attempt === 'fresh') _crumbTs = 0;
      const r = await tryYahoo(symbol, interval, range, true);
      if (r.ok) {
        return res.status(200).json({ s: 'ok', src: `yahoo-crumb-${attempt}`, version: VERSION,
          t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v });
      }
      tried.push({ src: `yahoo-crumb-${attempt}`, status: r.status, error: r.error, detail: r.detail });
      if (r.status !== 401 && r.status !== 403) break;
    } catch (e) {
      tried.push({ src: `yahoo-crumb-${attempt}`, error: String(e.message || e).slice(0, 200) });
      break;
    }
  }

  // Strategy 3 — Stooq fallback (daily intervals only).
  if (DAILY_INTERVALS.has(interval)) {
    try {
      const r = await tryStooq(symbol, range);
      if (r.ok) {
        return res.status(200).json({ s: 'ok', src: 'stooq', version: VERSION,
          t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v });
      }
      tried.push({ src: 'stooq', status: r.status, error: r.error, detail: r.detail });
    } catch (e) {
      tried.push({ src: 'stooq', error: String(e.message || e).slice(0, 200) });
    }
  } else {
    tried.push({ src: 'stooq', skipped: 'intraday not supported' });
  }

  return res.status(502).json({
    s: 'no_data',
    error: 'All upstream sources failed',
    tried,
    version: VERSION,
  });
}
