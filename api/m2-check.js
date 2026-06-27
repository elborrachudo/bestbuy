// api/m2-check.js — TEMP diagnostic. Probes candidate keyless M2 (FRED M2SL) sources and
// console.logs which is reachable + parseable from this serverless region. We read the
// result via Vercel runtime logs (the MCP web-fetch gateway drops slow response bodies,
// but logs flush). Per-fetch timeout so a blocked host can't hang the run. Gated by
// CRON_SECRET. Safe to delete once getM2Monthly's source is confirmed.

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/json,text/csv,text/plain,*/*',
};

const CANDIDATES = [
  'https://api.db.nomics.world/v22/search?q=M2SL&limit=3',
  'https://api.db.nomics.world/v22/series?series_ids=FRED/M2SL&observations=1',
  'https://api.db.nomics.world/v22/series/FRED/M2/M2SL?observations=1',
];

async function probe(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(url, { headers: UA, signal: ctrl.signal });
    const text = await r.text();
    console.log(`M2PROBE ok=${r.ok} status=${r.status} url=${url}`);
    console.log(`M2PROBE sample url=${url} :: ${text.slice(0, 500).replace(/\s+/g, ' ')}`);
  } catch (e) {
    console.log(`M2PROBE error url=${url} :: ${e.message}`);
  } finally { clearTimeout(t); }
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const q = (req.query && req.query.secret) || '';
    const auth = req.headers['authorization'] || '';
    if (q !== secret && auth !== `Bearer ${secret}`) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
  }
  for (const url of CANDIDATES) await probe(url);
  res.status(200).json({ ok: true, note: 'see runtime logs for M2PROBE lines' });
}
