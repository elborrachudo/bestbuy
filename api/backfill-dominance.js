// api/backfill-dominance.js — one-shot historical reconstruction of the daily market
// dominance series (BTC.D / ETH.D / STABLE.D / OTHERS.D) into public.dominance_history.
//
// Source: CoinGecko free/demo tier (see lib/dominance.js for method + honesty notes).
// Per-coin daily market cap (days=max — demo caps ~365d); TOTAL approximated by a
// calibrated top-N basket. Idempotent upsert by date. CRON_SECRET protected.
//
// Query: ?topN=100 (basket size) &pause=1400 (ms between CoinGecko calls).

import { sbUpsert } from '../lib/tokens.js';
import { buildDominanceSeries } from '../lib/dominance.js';

export default async function handler(req, res) {
  const base = process.env.SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const cgKey = process.env.COINGECKO_API_KEY || null;
  if (!base || !serviceKey) { res.status(500).json({ ok: false, error: 'missing supabase env' }); return; }
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const q = (req.query && req.query.secret) || '';
    if (q !== secret && (req.headers['authorization'] || '') !== `Bearer ${secret}`) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
  }

  const topN = Math.max(10, Math.min(250, Number((req.query && req.query.topN) || 50)));
  const pauseMs = Math.max(0, Number((req.query && req.query.pause) || 2200));
  // Soft budget under Vercel's 300s hard limit: stop fetching and compute/write with what we have.
  const deadlineMs = Math.max(30000, Math.min(285000, Number((req.query && req.query.deadline) || 240000)));

  try {
    const { rows, meta } = await buildDominanceSeries(cgKey, { topN, pauseMs, deadlineMs });
    if (!rows.length) { res.status(502).json({ ok: false, error: 'no dominance rows built', meta }); return; }
    for (let i = 0; i < rows.length; i += 500) await sbUpsert(base, serviceKey, 'dominance_history', rows.slice(i, i + 500), 'date');

    // Validation sample: sum should be ~100% every day.
    const sums = rows.map((r) => r.btc_d + r.eth_d + r.stable_d + r.others_d);
    const sumOk = sums.every((s) => Math.abs(s - 100) < 0.001);
    res.status(200).json({
      ok: true, upserted: rows.length, first: meta.first, last: meta.last,
      sum_check_100: sumOk, meta,
      sample_first: rows[0], sample_last: rows[rows.length - 1],
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
}
