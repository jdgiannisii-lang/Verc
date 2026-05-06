// Candle history via Yahoo Finance v8 chart API.
// Yahoo requires a session cookie + crumb token as of 2023.
// We fetch those once per warm instance and cache them for 50 minutes.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

// Module-scope crumb cache — survives across warm invocations on the same instance.
let _crumb = null;
let _cookie = null;
let _crumbTs = 0;
const CRUMB_TTL = 50 * 60 * 1000; // 50 min (Yahoo crumbs live ~60 min)

async function readCookies(headers) {
  // Node 18+ provides getSetCookie(); fall back to get('set-cookie').
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  }
  const raw = headers.get('set-cookie') || '';
  // Multiple cookies come back as a comma-separated string.
  return raw.split(/,(?=\s*\w+=)/).map(c => c.split(';')[0]).join('; ');
}

async function fetchCrumb() {
  // Step 1 — hit Yahoo's consent endpoint to receive session cookies.
  const consentRes = await fetch('https://fc.yahoo.com/', {
    headers: { 'User-Agent': UA, 'Accept': '*/*' },
    redirect: 'follow',
  });
  const cookie = await readCookies(consentRes.headers);

  // Step 2 — exchange cookies for a crumb token.
  const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/plain, */*',
      'Cookie': cookie,
    },
  });

  if (!crumbRes.ok) {
    const body = await crumbRes.text().catch(() => '');
    throw new Error(`crumb fetch failed ${crumbRes.status}: ${body.slice(0, 200)}`);
  }

  const crumb = (await crumbRes.text()).trim();
  if (!crumb || crumb.length < 3 || crumb.startsWith('<')) {
    throw new Error(`invalid crumb received: "${crumb.slice(0, 60)}"`);
  }

  return { crumb, cookie };
}

async function getAuth(forceRefresh = false) {
  if (!forceRefresh && _crumb && (Date.now() - _crumbTs) < CRUMB_TTL) {
    return { crumb: _crumb, cookie: _cookie };
  }
  const { crumb, cookie } = await fetchCrumb();
  _crumb = crumb;
  _cookie = cookie;
  _crumbTs = Date.now();
  return { crumb, cookie };
}

async function yahooChart(symbol, interval, range, crumb, cookie) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/'
    + encodeURIComponent(symbol)
    + `?interval=${encodeURIComponent(interval)}`
    + `&range=${encodeURIComponent(range)}`
    + `&includePrePost=false`
    + `&events=div%2Csplit`
    + `&crumb=${encodeURIComponent(crumb)}`;

  return fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, */*',
      'Cookie': cookie,
    },
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Input validation ────────────────────────────────────────────────────────
  const symbol = (req.query.symbol || 'GLD').trim().toUpperCase();
  const ALLOWED = new Set(['GLD', 'QQQ', 'SPY']);
  if (!ALLOWED.has(symbol)) {
    return res.status(400).json({ s: 'no_data', error: `Symbol "${symbol}" not supported` });
  }

  const interval = (req.query.interval || '5m').trim();
  const range    = (req.query.range    || '5d').trim();
  const VALID_INT = new Set(['1m','2m','5m','15m','30m','60m','90m','1h','1d','5d','1wk','1mo','3mo']);
  const VALID_RNG = new Set(['1d','5d','1mo','3mo','6mo','1y','2y','5y','10y','ytd','max']);
  if (!VALID_INT.has(interval)) {
    return res.status(400).json({ s: 'no_data', error: `Invalid interval "${interval}"` });
  }
  if (!VALID_RNG.has(range)) {
    return res.status(400).json({ s: 'no_data', error: `Invalid range "${range}"` });
  }

  // ── Fetch with auto-retry on stale crumb ───────────────────────────────────
  let auth, upstream;
  try {
    auth     = await getAuth();
    upstream = await yahooChart(symbol, interval, range, auth.crumb, auth.cookie);

    // 401/403 usually means the cached crumb expired — refresh and retry once.
    if (upstream.status === 401 || upstream.status === 403) {
      _crumbTs = 0; // bust cache
      auth     = await getAuth(true);
      upstream = await yahooChart(symbol, interval, range, auth.crumb, auth.cookie);
    }
  } catch (err) {
    return res.status(500).json({
      s: 'no_data',
      error: 'Yahoo auth failed',
      detail: String(err.message || err).slice(0, 400),
    });
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    return res.status(upstream.status).json({
      s: 'no_data',
      error: `Yahoo HTTP ${upstream.status}`,
      detail: detail.slice(0, 400),
    });
  }

  // ── Parse response ─────────────────────────────────────────────────────────
  let data;
  try {
    data = await upstream.json();
  } catch (_) {
    return res.status(502).json({ s: 'no_data', error: 'Yahoo returned non-JSON' });
  }

  const result = data?.chart?.result?.[0];
  if (!result || !Array.isArray(result.timestamp)) {
    const yErr = data?.chart?.error;
    return res.status(502).json({
      s: 'no_data',
      error: 'Empty Yahoo chart response',
      detail: yErr ? (yErr.description || yErr.code) : JSON.stringify(data).slice(0, 200),
    });
  }

  const timestamps = result.timestamp;
  const q = result.indicators?.quote?.[0];
  if (!q) {
    return res.status(502).json({ s: 'no_data', error: 'Missing quote indicators in Yahoo response' });
  }

  // Build output, skipping null bars (Yahoo emits gaps for market closures).
  const out = { s: 'ok', t: [], o: [], h: [], l: [], c: [], v: [] };
  for (let i = 0; i < timestamps.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    out.t.push(timestamps[i]);
    out.o.push(+o);
    out.h.push(+h);
    out.l.push(+l);
    out.c.push(+c);
    out.v.push(q.volume?.[i] != null ? +q.volume[i] : 0);
  }

  if (out.t.length === 0) {
    return res.status(502).json({ s: 'no_data', error: 'No valid OHLC bars after filtering nulls' });
  }

  return res.status(200).json(out);
}
