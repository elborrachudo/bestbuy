// api/recompute-emissions.js — one-shot: recompute the emissions axis for EVERY
// existing reading using the real annual-inflation metric (Option B), so the 12-month
// backfill (which holds the old broken ≈0 emissions) and live rows land on the same
// scale and the progression chart has no step at the fix date.
//
// For each active token it fetches one 365d market_chart, reconstructs the
// circulating-supply series (circ ≈ market_cap / price), then for each stored row
// recomputes emissions_rate (annual inflation as of that row's date), score_emissions,
// and final_score. Only those three fields change — all other sub-scores are kept.
//
// Protected by CRON_SECRET (?secret= or Authorization: Bearer) when set. Idempotent.

import { getActiveTokens, sbSelect, sbUpsert } from '../lib/tokens.js';
import { getCoinGeckoPriceSeries, buildCircSeries } from '../lib/sources.js';
import { scoreEmissions, annualInflationAt, scoreFundamentals, scoreTechnicals, blendPillars, round1 } from '../lib/scoring.js';

const PAGE = 1000;

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
      const series = await getCoinGeckoPriceSeries(t.coingecko_id, 365, cgKey);
      const circSeries = buildCircSeries(series);
      if (circSeries.length < 2) { summary.push({ symbol: t.symbol, error: 'no-circ-series' }); continue; }

      const rows = await sbSelect(
        base, serviceKey,
        `score_readings?token_id=eq.${t.id}&select=*&order=fetched_at.asc&limit=${PAGE}`
      );

      const num = (v) => (v == null ? null : Number(v));
      let changed = 0, nonzero = 0;
      const updates = rows.map((row) => {
        const nowT = new Date(row.fetched_at).getTime();
        const inflation = annualInflationAt(circSeries, nowT);
        const emiss = round1(scoreEmissions(inflation));
        // Re-derive pillars + blended final (sentiment stays null).
        const fundamentals = scoreFundamentals(num(row.score_tvl_rev), emiss, t.supply_mechanism);
        const technicals = scoreTechnicals(num(row.score_price_ma), num(row.score_below_high), num(row.score_rsi));
        const finalScore = blendPillars(fundamentals, technicals, null);
        if (emiss != null && emiss > 0) nonzero++;
        if (Number(row.final_score) !== finalScore) changed++;
        return {
          ...row,
          emissions_rate: inflation,
          score_emissions: emiss,
          score_fundamentals: round1(fundamentals),
          score_technicals: round1(technicals),
          score_sentiment: null,
          final_score: finalScore,
        };
      });

      for (let i = 0; i < updates.length; i += 100) {
        await sbUpsert(base, serviceKey, 'score_readings', updates.slice(i, i + 100), 'id');
      }
      summary.push({ symbol: t.symbol, rows: rows.length, changed, nonzero_emissions: nonzero });
    } catch (e) {
      summary.push({ symbol: t.symbol, error: e.message });
    }
  }

  res.status(200).json({ ok: true, summary });
}
