// api/backfill-cycle.js — Phase 1 one-shot backfill (server-side; needs egress for BTC).
//
// 1. Fetch BTC daily history, classify the market phase per day, upsert market_cycle.
// 2. Regenerate every token's BACKFILL signals with the new rules: RSI trigger + 30d
//    cooldown + cycle-phase conditioning + clean position state machine (no orphan
//    sells), stamping cycle_phase. Live signals (is_backfill=false) are left intact.
//
// Pure recompute from already-stored readings + freshly fetched BTC (no token refetch).
// Idempotent. Protected by CRON_SECRET when set. Optional ?symbol= for one token.

import { getActiveTokens, sbSelect, sbInsert, sbDelete, sbUpsert } from '../lib/tokens.js';
import { stochRsiSeries, macdSeries } from '../lib/scoring.js';
import { generateSignals } from '../lib/signals.js';
import { classifySeries } from '../lib/cycle.js';
import { fetchGlobalM2Inputs, globalM2MetricsAsOf } from '../lib/globalm2.js';
import { structuralDeclineSeries } from '../lib/survivorship.js';

const N = (x) => (x == null ? null : Number(x));

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
    if (auth !== `Bearer ${secret}` && q !== secret) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
  }
  const onlySymbol = ((req.query && req.query.symbol) || '').trim().toUpperCase();

  // ── 1. Market cycle from the LONG BTC history (Phase 3) ─────────────────────
  // Read the full daily series from btc_history (≥2011) so the 200-week MA is COMPLETE
  // (ma200w_partial=false) and the price percentile is over 10+ years, not ~1.
  let phaseByDate = {}, cycleRows = 0, phaseDist = {};
  try {
    const hist = await sbSelect(base, serviceKey, 'btc_history?select=date,close&order=date.asc&limit=20000');
    const series = hist.map((r) => ({ day: r.date, price: N(r.close) })).filter((r) => Number.isFinite(r.price));
    if (series.length < 400) { res.status(409).json({ ok: false, error: `btc_history thin (${series.length}); run /api/import-btc-history first` }); return; }
    const prices = series.map((r) => r.price);
    const cls = classifySeries(prices);   // 4-indicator consensus + hysteresis, per day
    // Global M2 liquidity confirmer (best-effort; attached per-day as-of).
    let g2 = null; try { g2 = await fetchGlobalM2Inputs(); } catch (e) { console.warn('global m2 failed:', e.message); }
    const rows = series.map((r, i) => {
      const iv = cls[i].indicators;
      if (g2) { const m2 = globalM2MetricsAsOf(g2, r.day); if (m2) Object.assign(iv, m2); }
      phaseByDate[r.day] = cls[i].phase;
      phaseDist[cls[i].phase] = (phaseDist[cls[i].phase] || 0) + 1;
      return { cycle_date: r.day, btc_price: r.price, phase: cls[i].phase, indicator_values: iv };
    });
    for (let i = 0; i < rows.length; i += 500) await sbUpsert(base, serviceKey, 'market_cycle', rows.slice(i, i + 500), 'cycle_date');
    cycleRows = rows.length;
  } catch (e) {
    res.status(502).json({ ok: false, error: `btc/market_cycle: ${e.message}` });
    return;
  }

  // ── 2. Regenerate conditioned backfill signals per token ────────────────────
  let tokens;
  try { tokens = await getActiveTokens(base, serviceKey); }
  catch (e) { res.status(500).json({ ok: false, error: `load tokens: ${e.message}` }); return; }
  if (onlySymbol) tokens = tokens.filter((t) => (t.symbol || '').toUpperCase() === onlySymbol);

  const summary = [];
  for (const t of tokens) {
    try {
      const readings = await sbSelect(
        base, serviceKey,
        `score_readings?token_id=eq.${t.id}` +
        `&select=fetched_at,price,rsi_14,stochrsi_14,macd_histogram,score_below_high,score_fundamentals,score_activity,is_backfill` +
        `&order=fetched_at.asc&limit=100000`
      );
      if (!readings.length) { summary.push({ symbol: t.symbol, skipped: 'no-readings' }); continue; }

      // one row per UTC day (prefer backfill, else latest of the day)
      const byDay = new Map();
      for (const r of readings) {
        const day = r.fetched_at.slice(0, 10), c = byDay.get(day);
        if (!c || (r.is_backfill && !c.is_backfill) || (r.is_backfill === c.is_backfill && r.fetched_at > c.fetched_at)) byDay.set(day, r);
      }
      const daily = [...byDay.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([, r]) => r);
      const prices = daily.map((r) => N(r.price));
      if (prices.filter((p) => p != null).length < 15) { summary.push({ symbol: t.symbol, skipped: 'thin' }); continue; }
      const stoch = stochRsiSeries(prices), macd = macdSeries(prices);
      const decline = structuralDeclineSeries(prices);
      const enriched = daily.map((r, i) => ({
        fetched_at: r.fetched_at, rsi_14: N(r.rsi_14),
        stochrsi_14: r.stochrsi_14 != null ? N(r.stochrsi_14) : stoch[i],
        macd_histogram: r.macd_histogram != null ? N(r.macd_histogram) : macd.hist[i],
        score_below_high: N(r.score_below_high), score_fundamentals: N(r.score_fundamentals),
        score_activity: N(r.score_activity), price: N(r.price), structural_decline: decline[i],
      }));

      const conditioned = generateSignals(enriched, phaseByDate);
      const unconditioned = generateSignals(enriched);   // for the suppression audit
      const buysCond = conditioned.filter((s) => s.side === 'BUY').length;
      const buysUncond = unconditioned.filter((s) => s.side === 'BUY').length;

      const rows = conditioned.map((s) => ({ ...s, token_id: t.id, is_backfill: true }));
      await sbDelete(base, serviceKey, 'signals', `token_id=eq.${t.id}&is_backfill=eq.true`);
      for (let i = 0; i < rows.length; i += 100) if (rows.slice(i, i + 100).length) await sbInsert(base, serviceKey, 'signals', rows.slice(i, i + 100));

      summary.push({
        symbol: t.symbol, signals: rows.length,
        buys: buysCond, sells: rows.filter((s) => s.side === 'SELL').length,
        buys_suppressed_by_phase: Math.max(0, buysUncond - buysCond),
      });
    } catch (e) { summary.push({ symbol: t.symbol, error: e.message }); }
  }

  res.status(200).json({ ok: true, market_cycle_rows: cycleRows, phase_distribution: phaseDist, current_phase: phaseByDate[Object.keys(phaseByDate).slice(-1)[0]], tokens: summary });
}
