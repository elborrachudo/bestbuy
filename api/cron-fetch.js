// api/cron-fetch.js — runs 3×/day (00:00, 08:00, 16:00 UTC) via Vercel cron.
// Loads active tokens, fetches sources, scores, and writes one live row each.
// Never writes a gap: on any per-token failure it still inserts the row with the
// inputs it has and nulls the rest.

import { getActiveTokens, sbInsert, recentReadingExists } from '../lib/tokens.js';
import { fetchTokenInputs } from '../lib/sources.js';
import { buildReading, round1 } from '../lib/scoring.js';

export default async function handler(req, res) {
  const base = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const cgKey = process.env.COINGECKO_API_KEY || null;

  if (!base || !serviceKey) {
    res.status(500).json({ ok: false, error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' });
    return;
  }

  // Optional: protect against public invocation. If CRON_SECRET is set, require it
  // (Vercel cron sends it as `Authorization: Bearer <CRON_SECRET>`).
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${secret}`) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
  }

  const now = new Date();
  const fetchedAt = now.toISOString();
  const summary = [];

  let tokens;
  try {
    tokens = await getActiveTokens(base, serviceKey);
  } catch (e) {
    res.status(500).json({ ok: false, error: `load tokens: ${e.message}` });
    return;
  }

  for (const t of tokens) {
    try {
      // Idempotency: skip if a row already landed in the last ~2h for this token.
      const twoHoursAgo = new Date(now.getTime() - 2 * 3600 * 1000).toISOString();
      if (await recentReadingExists(base, serviceKey, t.id, twoHoursAgo)) {
        summary.push({ symbol: t.symbol, skipped: 'recent-row' });
        continue;
      }

      const inputs = await fetchTokenInputs(t, cgKey);
      const r = buildReading(inputs);

      const row = {
        token_id: t.id,
        fetched_at: fetchedAt,
        final_score: r.final_score,
        score_price_ma: r.score_price_ma,
        score_below_high: r.score_below_high,
        score_rsi: r.score_rsi,
        score_tvl_rev: r.score_tvl_rev,
        score_emissions: r.score_emissions,
        price: inputs.price,
        ma_50: inputs.ma50,
        ma_200: inputs.ma200,
        rsi_14: inputs.rsi14,
        tvl: inputs.tvlNow,
        holders_revenue: inputs.holdersRevenue,
        circ_supply: inputs.circSupply,
        emissions_rate: r.emissions_rate,
        reweighted: r.reweighted,
        is_backfill: false,
      };

      // A reading with no usable price isn't worth storing — but anything with a
      // score goes in. Guard only against a fully-empty fetch.
      if (row.final_score == null) {
        summary.push({ symbol: t.symbol, error: 'no-score', failures: inputs._failures });
        continue;
      }

      await sbInsert(base, serviceKey, 'score_readings', [row]);
      summary.push({
        symbol: t.symbol,
        score: row.final_score,
        reweighted: r.reweighted,
        failures: inputs._failures.length ? inputs._failures : undefined,
      });
    } catch (e) {
      summary.push({ symbol: t.symbol, error: e.message });
    }
  }

  res.status(200).json({ ok: true, fetched_at: fetchedAt, tokens: summary });
}
