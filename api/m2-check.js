// api/m2-check.js — TEMP diagnostic. Round 4: nail the US (Fed) M2 data file, confirm an
// FX source (ECB EUR/USD), and find a reachable China M2 series. console.logs results
// (read via runtime logs). Per-fetch timeout. Gated by CRON_SECRET. Delete when source set.

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/json,text/csv,text/plain,*/*',
};

// Plain reachability/shape probes.
const CANDIDATES = [
  // Fed DDP CSV for H.6 M2 (seasonally adjusted, monthly) — the canonical M2SL series.
  'https://www.federalreserve.gov/datadownload/Output.aspx?rel=H6&series=797ed3d5fbc2d6b06b07d4e1f6c9f0f0&lastobs=&filetype=csv&label=include&layout=seriescolumn',
  // ECB FX reference rate EUR/USD (monthly) — needed to convert EU/CN M2 into USD.
  'https://data-api.ecb.europa.eu/service/data/EXR/M.USD.EUR.SP00.A?lastNObservations=2&format=csvdata',
  // ECB FX reference rate CNY/EUR — for China M2 (CNY) → USD via the cross.
  'https://data-api.ecb.europa.eu/service/data/EXR/M.CNY.EUR.SP00.A?lastNObservations=2&format=csvdata',
  // China broad money discovery via DBnomics IMF IFS (correct codes unknown — list series).
  'https://api.db.nomics.world/v22/series/IMF/IFS?dimensions=%7B%22REF_AREA%22%3A%5B%22CN%22%5D%7D&q=broad%20money&limit=4',
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

// Special: pull the Fed H.6 current HTML and surface any data-download / csv / txt links
// plus the area around the first "M2" so we can read a US M2 series straight from it.
async function probeFedHtml() {
  const url = 'https://www.federalreserve.gov/releases/h6/current/';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(url, { headers: UA, signal: ctrl.signal });
    const html = await r.text();
    const links = [...html.matchAll(/href="([^"]*(?:datadownload|\.csv|\.txt|h6)[^"]*)"/gi)].map((m) => m[1]);
    console.log(`M2PROBE fedlinks ${JSON.stringify([...new Set(links)].slice(0, 20))}`);
    const idx = html.search(/M2\b/);
    console.log(`M2PROBE fedM2ctx :: ${idx < 0 ? 'no M2' : html.slice(idx, idx + 400).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')}`);
  } catch (e) {
    console.log(`M2PROBE fedhtml error :: ${e.name}/${e.message}`);
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
  await probeFedHtml();
  res.status(200).json({ ok: true, note: 'see runtime logs for M2PROBE lines' });
}
