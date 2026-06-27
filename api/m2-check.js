// api/m2-check.js — TEMP diagnostic. Round 9: dump the Fed DDP M2 CSV layout + ECB BSI M2
// rows so the parser can be written correctly. console.logs (read via runtime logs).

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'text/html,application/json,text/csv,*/*',
};

async function get(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { const r = await fetch(url, { headers: UA, signal: ctrl.signal }); return { status: r.status, text: await r.text() }; }
  catch (e) { return { error: `${e.name}/${e.message}` }; }
  finally { clearTimeout(t); }
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const q = (req.query && req.query.secret) || '';
    if (q !== secret && (req.headers['authorization'] || '') !== `Bearer ${secret}`) { res.status(401).json({ ok: false }); return; }
  }
  const fed = await get('https://www.federalreserve.gov/datadownload/Output.aspx?rel=H6&series=798e2796917702a5f8423426ba7e6b42&lastobs=&from=&to=&filetype=csv&label=include&layout=seriescolumn&type=package');
  const ftxt = fed.text || '';
  const flines = ftxt.split('\n');
  console.log(`FEDCSV status=${fed.status} lines=${flines.length}`);
  flines.slice(0, 8).forEach((l, i) => console.log(`FEDCSV[${i}] ${l.slice(0, 200)}`));
  console.log(`FEDCSV[last] ${flines[flines.length - 2] || flines[flines.length - 1]}`);

  const ecb = await get('https://data-api.ecb.europa.eu/service/data/BSI/M.U2.Y.V.M20.X.1.U2.2300.Z01.E?lastNObservations=3&format=csvdata&detail=dataonly');
  const elines = (ecb.text || '').split('\n');
  console.log(`ECBCSV status=${ecb.status} lines=${elines.length}`);
  elines.slice(0, 5).forEach((l, i) => console.log(`ECBCSV[${i}] ${l.slice(0, 200)}`));
  res.status(200).json({ ok: true, note: 'see logs FEDCSV / ECBCSV' });
}
