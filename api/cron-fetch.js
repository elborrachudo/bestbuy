// api/cron-fetch.js — runs 3×/day (00:00, 08:00, 16:00 UTC) via Vercel cron.
// Loads active tokens, fetches sources, scores, and writes one live row each.
// Never writes a gap: on any per-token failure it still inserts the row with the
// inputs it has and nulls the rest.

import {
  getActiveTokens, sbInsert, sbUpsert, recentReadingExists, getPrevActivitySnapshot,
  getPrevReadingForSignals, getLastSignalDates,
} from '../lib/tokens.js';
import { fetchTokenInputs } from '../lib/sources.js';
import { fetchActivityRaw } from '../lib/activity.js';
import { buildReading, scoreActivity, round1 } from '../lib/scoring.js';
import { detectLiveSignal } from '../lib/signals.js';
import { getBtcDailySeries, classifyLatest, getM2Monthly, m2MetricsAsOf } from '../lib/cycle.js';

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

  // Global market-cycle phase (via BTC) — computed once per run, conditions every
  // token's signal and is recorded in market_cycle. Best-effort: if BTC fetch fails,
  // the phase stays null and signals fall back to unconditioned behavior.
  let currentPhase = null;
  try {
    const btc = await getBtcDailySeries(365, cgKey);
    if (btc.length) {
      const prices = btc.map((p) => p.price);
      const i = prices.length - 1;
      const { phase, indicators } = classifyLatest(prices);   // 4-indicator consensus + hysteresis
      currentPhase = phase;
      const cycleDay = new Date(btc[i].ts).toISOString().slice(0, 10);
      // M2 liquidity confirmer (best-effort; never blocks the cycle row).
      try { const m2 = m2MetricsAsOf(await getM2Monthly(), cycleDay); if (m2) Object.assign(indicators, m2); }
      catch (e) { summary.push({ m2_error: e.message }); }
      await sbUpsert(base, serviceKey, 'market_cycle', [{
        cycle_date: cycleDay,
        btc_price: prices[i], phase, indicator_values: indicators, updated_at: fetchedAt,
      }], 'cycle_date');
    }
  } catch (e) { summary.push({ cycle_error: e.message }); }

  let tokens;
  try {
    tokens = await getActiveTokens(base, serviceKey);
  } catch (e) {
    res.status(500).json({ ok: false, error: `load tokens: ${e.message}` });
    return;
  }

  // Fisher–Yates shuffle: if a run still hits a rate-limit or time cap, the tokens
  // that get dropped vary each time instead of always being the last in load order
  // — so no single token is permanently starved of live readings.
  for (let i = tokens.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [tokens[i], tokens[j]] = [tokens[j], tokens[i]];
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

      // On-chain Activity (live only). Snapshot the raw counts, then score the FLOW
      // against the previous live snapshot. No prior snapshot → score stays null
      // (no fabricated history); the raw counts are still stored to seed the next.
      const act = await fetchActivityRaw(t);
      const actRaw = act.raw;
      let activityScore = null;
      if (actRaw) {
        const prev = await getPrevActivitySnapshot(base, serviceKey, t.id);
        if (prev) {
          const intervalDays = (now.getTime() - new Date(prev.fetched_at).getTime()) / 86400000;
          activityScore = scoreActivity(prev, actRaw, intervalDays);
        }
      }
      inputs.activityScore = activityScore;

      const r = buildReading(inputs);

      const row = {
        token_id: t.id,
        fetched_at: fetchedAt,
        source_tier: 'live',
        final_score: r.final_score,
        score_price_ma: r.score_price_ma,
        score_below_high: r.score_below_high,
        score_rsi: r.score_rsi,
        score_tvl_rev: r.score_tvl_rev,
        score_emissions: r.score_emissions,
        score_fundamentals: r.score_fundamentals,
        score_technicals: r.score_technicals,
        score_activity: r.score_activity,
        price: inputs.price,
        ma_50: inputs.ma50,
        ma_200: inputs.ma200,
        rsi_14: inputs.rsi14,
        dist_from_low_pct: r.dist_from_low_pct,
        tvl: inputs.tvlNow,
        holders_revenue: inputs.holdersRevenue,
        circ_supply: inputs.circSupply,
        emissions_rate: r.emissions_rate,
        stochrsi_14: inputs.stochrsi14,
        macd_line: inputs.macdLine,
        macd_signal: inputs.macdSignal,
        macd_histogram: inputs.macdHistogram,
        active_addresses: actRaw ? actRaw.active_addresses : null,
        holder_count: actRaw ? actRaw.holder_count : null,
        transfer_count: actRaw ? actRaw.transfer_count : null,
        activity_error: act.error,
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

      // ── Graded signal (independent of the score/pillars) ──────────────────
      // The RSI is the trigger; confluence only grades confidence. Crossovers use
      // the previous reading; per-side 30d cooldown uses the last signal dates.
      let firedSignal;
      try {
        const cur = {
          rsi_14: row.rsi_14, stochrsi_14: row.stochrsi_14, macd_histogram: row.macd_histogram,
          score_below_high: row.score_below_high, score_fundamentals: row.score_fundamentals,
          score_activity: row.score_activity, price: row.price,
          structural_decline: inputs.structuralDecline,   // §2.2 survivorship
        };
        const prevR = await getPrevReadingForSignals(base, serviceKey, t.id, fetchedAt);
        const last = await getLastSignalDates(base, serviceKey, t.id);
        const sig = detectLiveSignal(cur, prevR, last.BUY, last.SELL, fetchedAt, currentPhase);
        if (sig) {
          await sbInsert(base, serviceKey, 'signals', [{ ...sig, token_id: t.id, is_backfill: false }]);
          firedSignal = { side: sig.side, confidence: sig.confidence, strength: sig.strength, phase: sig.cycle_phase };
        }
      } catch (e) { firedSignal = { error: e.message }; }

      summary.push({
        symbol: t.symbol,
        score: row.final_score,
        reweighted: r.reweighted,
        activity: r.score_activity,
        holders: row.holder_count,
        transfers: row.transfer_count,
        signal: firedSignal,
        activity_error: act.error || undefined,
        failures: inputs._failures.length ? inputs._failures : undefined,
      });
    } catch (e) {
      summary.push({ symbol: t.symbol, error: e.message });
    }
  }

  res.status(200).json({ ok: true, fetched_at: fetchedAt, tokens: summary });
}
