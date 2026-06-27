// api/m2-check.js — TEMP diagnostic. Probes machine-readable money-supply endpoints for
// the three central banks (Fed / ECB / PBoC-via-IMF) for REACHABILITY from this serverless
// region + response shape. console.logs each (read via runtime logs; the MCP web-fetch
// gateway drops slow bodies but logs flush). Per-fetch timeout. Gated by CRON_SECRET.
// Delete once the global-M2 source set is confirmed.

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/json,text/csv,text/plain,*/*',
};

const CANDIDATES = [
  // DBnomics provider directory — confirm IMF exists + see dataset codes.
  'https://api.db.nomics.world/v22/providers/IMF',
  // IMF IFS Broad Money, monthly — US (domestic ccy = USD), China & Euro area (in USD).
  'https://api.db.nomics.world/v22/series/IMF/IFS/M.US.FMB_XDC?observations=1',
  'https://api.db.nomics.world/v22/series/IMF/IFS/M.CN.FMB_USD?observations=1',
  'https://api.db.nomics.world/v22/series/IMF/IFS/M.U2.FMB_USD?observations=1',
  // ECB Data Portal API (keyless) — Euro-area M2 (M20), monthly index of stocks.
  'https://data-api.ecb.europa.eu/service/data/BSI/M.U2.Y.V.M20.X.1.U2.2300.Z01.E?lastNObservations=2&format=csvdata',
  // Fed's own site — is federalreserve.gov reachable (unlike fred.stlouisfed.org)?
  'https://www.federalreserve.gov/releases/h6/current/',
];

async function probe(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(url, { headers: UA, signal: ctrl.signal });
    const text = await r.text();
    console.log(`M2PROBE ok=${r.ok} status=${r.status} len=${text.length} url=${url}`);
    console.log(`M2PROBE sample url=${url} :: ${text.slice(0, 650).replace(/\s+/g, ' ')}`);
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
