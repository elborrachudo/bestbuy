// api/m2-check.js — TEMP validation of lib/globalm2.js end-to-end. Logs the assembled
// global M2 (level, YoY, breakdown, coverage) for the latest month and a few back-months.
// Read via runtime logs. CRON_SECRET. Delete after validation.

import { fetchGlobalM2Inputs, globalM2MetricsAsOf } from '../lib/globalm2.js';

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const q = (req.query && req.query.secret) || '';
    if (q !== secret && (req.headers['authorization'] || '') !== `Bearer ${secret}`) { res.status(401).json({ ok: false }); return; }
  }
  try {
    const inp = await fetchGlobalM2Inputs();
    console.log(`M2G sizes us=${inp.us.size} eu=${inp.eu.size} cn=${inp.cnLvl.size} fxUsd=${inp.fx.usdEur.size} fxCny=${inp.fx.cnyEur.size}`);
    console.log(`M2G cn months=${JSON.stringify([...inp.cnLvl.keys()].sort().slice(-6))}`);
    for (const d of ['2026-06-27', '2026-03-15', '2025-12-15', '2025-06-15']) {
      console.log(`M2G asOf=${d} :: ${JSON.stringify(globalM2MetricsAsOf(inp, d))}`);
    }
    res.status(200).json({ ok: true, note: 'see M2G logs' });
  } catch (e) {
    console.log(`M2G ERROR :: ${e.stack || e.message}`);
    res.status(200).json({ ok: false, error: e.message });
  }
}
