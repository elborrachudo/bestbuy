// api/m2-check.js — TEMP diagnostic. Probes candidate keyless M2 (FRED M2SL) sources
// and reports which one is reachable + parseable from this serverless region. Fast (no
// token loop), so the response returns before any gateway timeout. Gated by CRON_SECRET.
// Safe to delete once getM2Monthly's source is confirmed.

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/json,text/csv,text/plain,*/*',
};

const CANDIDATES = [
  'https://api.db.nomics.world/v22/series?series_ids=FRED/M2SL&observations=1',
  'https://api.db.nomics.world/v22/series/FRED/M2/M2SL?observations=1',
  'https://api.db.nomics.world/v22/series/FRED/H6/M2SL?observations=1',
  'https://api.db.nomics.world/v22/search?q=M2SL&limit=3',
  'https://fred.stlouisfed.org/graph/fredgraph.csv?id=M2SL&cosd=2022-01-01',
];

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const q = (req.query && req.query.secret) || '';
    const auth = req.headers['authorization'] || '';
    if (q !== secret && auth !== `Bearer ${secret}`) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
  }
  const out = [];
  for (const url of CANDIDATES) {
    try {
      const r = await fetch(url, { headers: UA });
      const text = await r.text();
      out.push({ url, ok: r.ok, status: r.status, ct: r.headers.get('content-type'), sample: text.slice(0, 600) });
    } catch (e) {
      out.push({ url, error: e.message });
    }
  }
  res.status(200).json({ ok: true, results: out });
}
