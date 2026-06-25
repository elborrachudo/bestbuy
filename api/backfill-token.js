// api/backfill-token.js — seeds 365d of history for any ACTIVE token that has NO
// readings yet. Called by the frontend right after a token is added, so a new
// token's chart isn't empty until the next cron run.
//
// Safe to call unauthenticated: it only ever INSERTS history for zero-history
// tokens (never deletes, never touches existing data), and a single new token is
// one CoinGecko series — no rate-limit pressure like the full multi-token backfill.

import { getActiveTokens, sbSelect } from '../lib/tokens.js';
import { seedTokenHistory } from '../lib/seed.js';

export default async function handler(req, res) {
  const base = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const cgKey = process.env.COINGECKO_API_KEY || null;

  if (!base || !serviceKey) {
    res.status(500).json({ ok: false, error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' });
    return;
  }

  let tokens;
  try {
    tokens = await getActiveTokens(base, serviceKey);
  } catch (e) {
    res.status(500).json({ ok: false, error: `load tokens: ${e.message}` });
    return;
  }

  const seeded = [];
  for (const t of tokens) {
    try {
      const existing = await sbSelect(base, serviceKey, `score_readings?token_id=eq.${t.id}&select=id&limit=1`);
      if (existing.length) continue; // already has history → leave untouched
      seeded.push(await seedTokenHistory(base, serviceKey, t, { days: 365, reset: false, cgKey }));
    } catch (e) {
      seeded.push({ symbol: t.symbol, error: e.message });
    }
  }

  res.status(200).json({ ok: true, seeded });
}
