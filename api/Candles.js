// Historical OHLC candle endpoint backed by Yahoo Finance's v8 chart API.
// Free, no API key required, supports intraday + multi-year history for ETFs.
// Response shape mirrors Finnhub: { s, t, o, h, l, c, v }.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const symbol = (req.query.symbol || 'GLD').trim().toUpperCase();
  const ALLOWED = new Set(['GLD', 'QQQ', 'SPY']);
  if (!ALLOWED.has(symbol)) {
    return res.status(400).json({ s: 'no_data', error: `Symbol "${symbol}" not supported. Allowed: GLD, QQQ, SPY` });
  }

  const interval = (req.query.interval || '5m').trim();
  const range    = (req.query.range    || '5d').trim();
  const VALID_INT = new Set(['1m','2m','5m','15m','30m','60m','90m','1h','1d','5d','1wk','1mo','3mo']);
  const VALID_RNG = new Set(['1d','5d','1mo','3mo','6mo','1y','2y','5y','10y','ytd','max']);
  if (!VALID_INT.has(interval)) return res.status(400).json({ s: 'no_data', error: `Invalid interval "${interval}"` });
  if (!VALID_RNG.has(range))    return res.status(400).json({ s: 'no_data', error: `Invalid range "${range}"` });

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
              `?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}` +
              `&includePrePost=false&events=div%2Csplit`;

  try {
    const upstream = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'application/json,text/plain,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      return res.status(upstream.status).json({
        s: 'no_data',
        error: `Yahoo upstream ${upstream.status}`,
        detail: text.slice(0, 400),
      });
    }

    const data = await upstream.json();
    const result = data && data.chart && data.chart.result && data.chart.result[0];
    if (!result || !Array.isArray(result.timestamp) || !result.indicators || !result.indicators.quote) {
      const yErr = data && data.chart && data.chart.error;
      return res.status(502).json({
        s: 'no_data',
        error: 'Empty Yahoo response',
        detail: yErr ? (yErr.description || yErr.code) : 'no result',
      });
    }

    const t = result.timestamp;
    const q = result.indicators.quote[0];
    const out = { s: 'ok', symbol, interval, range, t: [], o: [], h: [], l: [], c: [], v: [] };

    for (let i = 0; i < t.length; i++) {
      const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
      if (o == null || h == null || l == null || c == null) continue;
      out.t.push(t[i]);
      out.o.push(+o);
      out.h.push(+h);
      out.l.push(+l);
      out.c.push(+c);
      out.v.push(q.volume && q.volume[i] != null ? +q.volume[i] : 0);
    }

    if (!out.t.length) {
      return res.status(502).json({ s: 'no_data', error: 'No valid bars after filtering' });
    }

    return res.status(200).json(out);
  } catch (err) {
    return res.status(500).json({ s: 'no_data', error: err.message || String(err) });
  }
}
