// api/backfill.js — one-shot historical seed so the chart isn't empty on day one.
// Seeds every active token via the shared seedTokenHistory helper.
//
// Honesty: backfill is 1 point/day (historical APIs don't give 3×/day); live is
// 3×/day going forward. Backfilled rows are stamped is_backfill=true.
//
// Protected: requires `?secret=<CRON_SECRET>` (or Authorization: Bearer) when
// CRON_SECRET is set, so it can't be triggered by the public. Optional query:
//   ?days=365   how far back to seed (capped at 365 by CoinGecko free tier)
//   ?reset=1    delete existing backfill rows for each token before reseeding

import { getActiveTokens } from '../lib/tokens.js';
import { seedTokenHistory } from '../lib/seed.js';

export default async function handler(req, res) {
  const base = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const cgKey = process.env.COINGECKO_API_KEY || null;

  if (!base || !serviceKey) {
    res.status(500).json({ ok: false, error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' });
    return;
  }

  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers['authorization'] || '';
    const q = (req.query && req.query.secret) || '';
    if (auth !== `Bearer ${secret}` && q !== secret) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
  }

  const days = Math.min(parseInt((req.query && req.query.days) || '365', 10) || 365, 365);
  const reset = (req.query && req.query.reset) === '1';

  let tokens;
  try {
    tokens = await getActiveTokens(base, serviceKey);
  } catch (e) {
    res.status(500).json({ ok: false, error: `load tokens: ${e.message}` });
    return;
  }

  const summary = [];
  for (const t of tokens) {
    try {
      summary.push(await seedTokenHistory(base, serviceKey, t, { days, reset, cgKey }));
    } catch (e) {
      summary.push({ symbol: t.symbol, error: e.message });
    }
  }

  res.status(200).json({ ok: true, summary });
}
