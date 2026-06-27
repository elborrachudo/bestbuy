// api/m2-check.js — TEMP diagnostic. Probes candidate US-M2 sources for REACHABILITY from
// this serverless region + response shape, console.logging each (read via runtime logs;
// the MCP web-fetch gateway drops slow bodies but logs flush). Per-fetch timeout so a
// blocked host can't hang the run. Gated by CRON_SECRET. Delete once the source is set.

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/json,text/csv,text/plain,*/*',
};

const CANDIDATES = [
  // FRED browser graph CSV — expected to fail (datacenter block) but confirm.
  'https://fred.stlouisfed.org/graph/fredgraph.csv?id=M2SL&cosd=2022-01-01',
  // FRED programmatic API subdomain, no key — a 400 "api_key required" proves REACHABILITY.
  'https://api.stlouisfed.org/fred/series/observations?series_id=M2SL&file_type=json',
  // DBnomics: does it carry US M2 under any non-FRED provider? (FRED itself was removed.)
  'https://api.db.nomics.world/v22/search?q=United%20States%20M2%20money&limit=5',
  'https://api.db.nomics.world/v22/search?q=broad%20money%20United%20States&limit=5',
];

async function probe(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(url, { headers: UA, signal: ctrl.signal });
    const text = await r.text();
    console.log(`M2PROBE ok=${r.ok} status=${r.status} url=${url}`);
    console.log(`M2PROBE sample url=${url} :: ${text.slice(0, 600).replace(/\s+/g, ' ')}`);
  } catch (e) {
    console.log(`M2PROBE error url=${url} :: ${e.name}/${e.message}`);
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
