// api/m2-check.js — TEMP diagnostic. Round 8 (decisive China test): from the PBoC category
// index, pair each article href with its title, pick the newest "Financial Statistics
// Report", fetch it, and check whether the M2 figure (+ YoY) is in the static HTML.
// console.logs results (read via runtime logs). CRON_SECRET.

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

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const q = (req.query && req.query.secret) || '';
    const auth = req.headers['authorization'] || '';
    if (q !== secret && auth !== `Bearer ${secret}`) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
  }

  const idx = await get('https://www.pbc.gov.cn/en/3688247/3688978/3709137/index.html');
  if (idx.error) { console.log(`CN error :: ${idx.error}`); res.status(200).json({ ok: true }); return; }
  const html = idx.text || '';
  // pair href + title for anchors whose title is a Financial Statistics Report.
  const pairs = [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*title="([^"]*Financial Statistics Report[^"]*)"/gi)]
    .map((m) => ({ href: m[1], title: m[2] }));
  console.log(`CN reports=${pairs.length} :: ${JSON.stringify(pairs.slice(0, 5))}`);

  for (const p of pairs.slice(0, 2)) {
    const url = p.href.startsWith('http') ? p.href : 'https://www.pbc.gov.cn' + p.href;
    const art = await get(url);
    const txt = (art.text || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
    const mi = txt.search(/\bM2\b|broad money/i);
    console.log(`CN art "${p.title}" status=${art.status} len=${(art.text || '').length} hasM2=${mi >= 0} url=${url}`);
    if (mi >= 0) console.log(`CN M2 :: ${txt.slice(mi - 80, mi + 220)}`);
  }
  res.status(200).json({ ok: true, note: 'see runtime logs for CN lines' });
}
