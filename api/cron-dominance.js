// api/cron-dominance.js — daily append of today's market-dominance snapshot into
// public.dominance_history. Uses the AUTHORITATIVE present /global total (exact live
// edge), unlike the historical backfill which approximates the total via a calibrated
// basket. Two CoinGecko calls only (/coins/markets + /global). Idempotent upsert by
// date — re-running the same day overwrites, never duplicates, never corrupts.

import { sbUpsert } from '../lib/tokens.js';
import { fetchDominanceSnapshot } from '../lib/dominance.js';

export default async function handler(req, res) {
  const base = process.env.SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const cgKey = process.env.COINGECKO_API_KEY || null;
  if (!base || !serviceKey) { res.status(500).json({ ok: false, error: 'missing supabase env' }); return; }
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers['authorization'] || '';
    const q = (req.query && req.query.secret) || '';
    if (auth !== `Bearer ${secret}` && q !== secret) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
  }

  try {
    const snap = await fetchDominanceSnapshot(cgKey);
    const { _stablecoins_used, ...row } = snap;
    await sbUpsert(base, serviceKey, 'dominance_history', [row], 'date');
    const sum = row.btc_d + row.eth_d + row.stable_d + row.others_d;
    res.status(200).json({ ok: true, row, stablecoins_used: _stablecoins_used, sum_check_100: Math.abs(sum - 100) < 0.001 });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
}
