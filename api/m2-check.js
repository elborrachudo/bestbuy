// api/m2-check.js — TEMP diagnostic. Round 6: (a) is PBoC reachable from this region and
// does its page carry M2 numbers? (b) extract the Fed H.6 seasonally-adjusted monthly M2
// table from the release HTML. console.logs results (read via runtime logs). CRON_SECRET.

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'text/html,application/json,text/csv,*/*',
  'Accept-Language': 'en,zh;q=0.9',
};

async function get(url, ms = 7000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers: UA, signal: ctrl.signal });
    const text = await r.text();
    return { status: r.status, ok: r.ok, text };
  } catch (e) { return { error: `${e.name}/${e.message}` }; }
  finally { clearTimeout(t); }
}

async function probePboc() {
  const urls = [
    'https://www.pbc.gov.cn/en/3688247/3688978/3709137/index.html',
    'http://www.pbc.gov.cn/en/3688247/3688978/3709137/index.html',
  ];
  for (const url of urls) {
    const r = await get(url, 8000);
    if (r.error) { console.log(`PBOC error url=${url} :: ${r.error}`); continue; }
    const txt = r.text || '';
    const hasM2 = /M2|money supply|Money Supply/i.test(txt);
    const links = [...txt.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((h) => /index|\.htm|money|\d{6,}/i.test(h));
    console.log(`PBOC ok=${r.ok} status=${r.status} len=${txt.length} hasM2=${hasM2} url=${url}`);
    console.log(`PBOC links :: ${JSON.stringify([...new Set(links)].slice(0, 14))}`);
    const idx = txt.search(/M2/);
    if (idx >= 0) console.log(`PBOC M2ctx :: ${txt.slice(idx - 40, idx + 260).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')}`);
  }
}

async function probeFed() {
  const r = await get('https://www.federalreserve.gov/releases/h6/current/', 8000);
  if (r.error) { console.log(`FED error :: ${r.error}`); return; }
  const plain = (r.text || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  console.log(`FED status=${r.status} len=${r.text.length}`);
  const sa = plain.search(/Seasonally adjusted/i);
  if (sa >= 0) console.log(`FED SAtable :: ${plain.slice(sa, sa + 620)}`);
  // also surface the "M2" memo growth-rate table region (has recent monthly levels nearby)
  const m2i = plain.indexOf('M2', sa > 0 ? sa : 0);
  if (m2i >= 0) console.log(`FED M2region :: ${plain.slice(m2i, m2i + 500)}`);
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const q = (req.query && req.query.secret) || '';
    const auth = req.headers['authorization'] || '';
    if (q !== secret && auth !== `Bearer ${secret}`) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
  }
  await probePboc();
  await probeFed();
  res.status(200).json({ ok: true, note: 'see runtime logs for PBOC / FED lines' });
}
