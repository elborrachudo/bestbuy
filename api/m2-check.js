// api/m2-check.js — TEMP diagnostic. Round 7: (a) Fed DDP series token for M2 (full
// history CSV); (b) follow PBoC category index into its latest monthly money-supply report
// and find the M2 figure. console.logs results (read via runtime logs). CRON_SECRET.

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'text/html,application/json,text/csv,*/*',
  'Accept-Language': 'en,zh;q=0.9',
};

async function get(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers: UA, signal: ctrl.signal });
    const text = await r.text();
    return { status: r.status, ok: r.ok, text };
  } catch (e) { return { error: `${e.name}/${e.message}` }; }
  finally { clearTimeout(t); }
}

async function probeFedDDP() {
  // The DDP "Choose" page lists series with their tokens; find the M2 (SA, monthly) token.
  const r = await get('https://www.federalreserve.gov/datadownload/Choose.aspx?rel=H6', 8000);
  if (r.error) { console.log(`FEDDDP error :: ${r.error}`); return; }
  const html = r.text || '';
  console.log(`FEDDDP status=${r.status} len=${html.length}`);
  // tokens look like 32-hex; log those near an "M2" label.
  const hexes = [...new Set([...html.matchAll(/[0-9a-f]{24,40}/g)].map((m) => m[0]))];
  console.log(`FEDDDP hexes=${hexes.length} sample=${JSON.stringify(hexes.slice(0, 8))}`);
  const m2i = html.search(/\bM2\b/);
  if (m2i >= 0) console.log(`FEDDDP M2ctx :: ${html.slice(m2i - 200, m2i + 120).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')}`);
  // also try the documented full-release CSV package (no token) just in case.
  const pkg = await get('https://www.federalreserve.gov/datadownload/Output.aspx?rel=H6&filetype=csv&label=include&layout=seriescolumn&from=01/01/2022&to=12/31/2026', 8000);
  console.log(`FEDPKG status=${pkg.status || pkg.error} len=${(pkg.text || '').length} head=${(pkg.text || '').slice(0, 200).replace(/\s+/g, ' ')}`);
}

async function probePbocArticle() {
  const idx = await get('https://www.pbc.gov.cn/en/3688247/3688978/3709137/index.html', 8000);
  if (idx.error) { console.log(`PBOC2 idx error :: ${idx.error}`); return; }
  const html = idx.text || '';
  // article links under this category usually look like /en/3688247/3688978/<id>/index.html
  const arts = [...new Set([...html.matchAll(/\/en\/3688247\/3688978\/(\d+)\/index\.html/g)].map((m) => m[0]))];
  console.log(`PBOC2 articleLinks=${arts.length} :: ${JSON.stringify(arts.slice(0, 6))}`);
  // also any dated title text near links
  const titles = [...html.matchAll(/(Money Supply|Financial Statistics)[^<]{0,40}/gi)].map((m) => m[0]);
  console.log(`PBOC2 titles :: ${JSON.stringify([...new Set(titles)].slice(0, 6))}`);
  if (arts.length) {
    const art = await get('https://www.pbc.gov.cn' + arts[0], 8000);
    const txt = (art.text || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
    const mi = txt.search(/broad money|M2/i);
    console.log(`PBOC2 art status=${art.status} len=${(art.text || '').length} url=${arts[0]}`);
    console.log(`PBOC2 artM2 :: ${mi < 0 ? 'no M2 text' : txt.slice(mi - 60, mi + 240)}`);
  }
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const q = (req.query && req.query.secret) || '';
    const auth = req.headers['authorization'] || '';
    if (q !== secret && auth !== `Bearer ${secret}`) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
  }
  await probeFedDDP();
  await probePbocArticle();
  res.status(200).json({ ok: true, note: 'see runtime logs for FEDDDP / FEDPKG / PBOC2 lines' });
}
