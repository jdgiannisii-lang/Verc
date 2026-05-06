export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.FINNHUB_KEY) {
    return res.status(500).json({ error: 'FINNHUB_KEY not configured' });
  }

  const symbol = (req.query.symbol || 'GLD').trim().toUpperCase();
  const ALLOWED = new Set(['GLD', 'QQQ', 'SPY']);
  if (!ALLOWED.has(symbol)) {
    return res.status(400).json({ error: 'Symbol not supported' });
  }

  const resolution = req.query.resolution || 'D';
  const VALID_RES = new Set(['1', '5', '15', '30', '60', 'D', 'W', 'M']);
  if (!VALID_RES.has(resolution)) {
    return res.status(400).json({ error: 'Invalid resolution' });
  }

  const to = Math.floor(Date.now() / 1000);
  const WINDOWS = {
    '5':  86400 * 5,
    '15': 86400 * 10,
    '60': 86400 * 60,
    'D':  86400 * 400,
    'W':  86400 * 365 * 5,
    'M':  86400 * 365 * 10,
  };
  const from = to - (WINDOWS[resolution] || 86400 * 365);

  try {
    const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${from}&to=${to}&token=${process.env.FINNHUB_KEY}`;
    const upstream = await fetch(url);
    if (!upstream.ok) {
      const text = await upstream.text();
      return res.status(upstream.status).json({ error: `Finnhub error ${upstream.status}`, detail: text });
    }
    const data = await upstream.json();
    if (data.s !== 'ok') {
      return res.status(502).json({ error: 'No data', status: data.s });
    }
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
