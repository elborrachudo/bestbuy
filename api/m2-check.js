// api/m2-check.js — TEMP diagnostic. Round 5: discover exact IMF/IFS broad-money series
// codes for US / China / Euro-area by LISTING matches (not guessing), with their latest
// observation. console.logs results (read via runtime logs). Gated by CRON_SECRET.

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/json,text/csv,text/plain,*/*',
};

async function discover(refArea) {
  const url = `https://api.db.nomics.world/v22/series/IMF/IFS?dimensions=%7B%22REF_AREA%22%3A%5B%22${refArea}%22%5D%7D&q=broad%20money&observations=1&limit=8`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 7000);
  try {
    const r = await fetch(url, { headers: UA, signal: ctrl.signal });
    const j = await r.json();
    const docs = (j && j.series && j.series.docs) || [];
    console.log(`M2DISC ${refArea} status=${r.status} num_found=${j && j.series && j.series.num_found} docs=${docs.length}`);
    for (const d of docs) {
      const per = d.period || [], val = d.value || [];
      const lastP = per[per.length - 1], lastV = val[val.length - 1];
      console.log(`M2DISC ${refArea} :: code=${d.series_code} name="${(d.series_name || '').slice(0, 70)}" last=${lastP}=${lastV} n=${per.length}`);
    }
  } catch (e) {
    console.log(`M2DISC ${refArea} error :: ${e.name}/${e.message}`);
  } finally { clearTimeout(t); }
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const q = (req.query && req.query.secret) || '';
    const auth = req.headers['authorization'] || '';
    if (q !== secret && auth !== `Bearer ${secret}`) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
  }
  for (const a of ['US', 'CN', 'U2']) await discover(a);
  res.status(200).json({ ok: true, note: 'see runtime logs for M2DISC lines' });
}
