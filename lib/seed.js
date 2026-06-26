// lib/seed.js — shared historical-seeding for one token. Used by the full
// backfill endpoint (all tokens) and the auto-backfill-on-add endpoint (a single
// new token). Pulls up to `days` of daily price, reconstructs the price sub-scores
// per day, overlays fundamentals (per-day TVL; revenue + supply held at current),
// and inserts one is_backfill=true row per day at that day's 00:00 UTC.

import {
  getCoinGeckoPriceSeries, getCoinGeckoSupply,
  getDefiLlamaTvl, getDefiLlamaRevenueAnnual,
  getDefiLlamaChainTvl, getDefiLlamaChainFeesAnnual,
  tvlAtDate, buildCircSeries,
} from './sources.js';
import { sma, highLow, rsi, buildReading, stochRsiSeries, macdSeries } from './scoring.js';
import { sbInsert, sbDelete } from './tokens.js';

const DAY_SEC = 86400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dayStartUtcIso(ms) {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

// Seed one token's history. Returns a per-token summary object.
export async function seedTokenHistory(base, serviceKey, t, { days = 365, reset = false, cgKey = null } = {}) {
  const series = await getCoinGeckoPriceSeries(t.coingecko_id, days, cgKey);
  if (!series.length) return { symbol: t.symbol, error: 'no-price-series' };
  const prices = series.map((p) => p.price);
  const circSeries = buildCircSeries(series);
  // Confluence indicators for the signals layer, computed once over the daily series
  // (honest nulls during EMA/RSI warmup). Not part of the score/pillars.
  const stochSeries = stochRsiSeries(prices);
  const macd = macdSeries(prices);

  // Fundamentals overlay: per-day TVL from history; revenue + supply at current.
  let tvlSeries = null, holdersRevenue = null, circSupply = null, totalSupply = null;
  if (t.defillama_slug) {
    try { tvlSeries = (await getDefiLlamaTvl(t.defillama_slug)).series; } catch { /* market-only day */ }
    await sleep(400);
    try { holdersRevenue = await getDefiLlamaRevenueAnnual(t.defillama_slug); } catch { /* */ }
    await sleep(400);
  } else if (t.defillama_chain) {
    // Native L1 token → chain-level TVL history + chain fees.
    try { tvlSeries = (await getDefiLlamaChainTvl(t.defillama_chain)).series; } catch { /* */ }
    await sleep(400);
    try { holdersRevenue = await getDefiLlamaChainFeesAnnual(t.defillama_chain); } catch { /* */ }
    await sleep(400);
  }
  try {
    const sup = await getCoinGeckoSupply(t.coingecko_id, cgKey);
    circSupply = sup.circSupply; totalSupply = sup.totalSupply;
  } catch { /* leave null → emissions sub null */ }

  if (reset) {
    await sbDelete(base, serviceKey, 'score_readings', `token_id=eq.${t.id}&is_backfill=eq.true`);
  }

  const rows = [];
  for (let i = 0; i < series.length; i++) {
    const ts = series[i].ts;
    const daySec = Math.floor(ts / 1000);
    const tvlNow = tvlSeries ? tvlAtDate(tvlSeries, daySec) : null;
    const tvl30dAgo = tvlSeries ? tvlAtDate(tvlSeries, daySec - 30 * DAY_SEC) : null;

    // Trailing 1-year high/low ending at day i (capped at available data).
    const hl = highLow(prices, 365, i);
    const inputs = {
      price: prices[i],
      ma50: sma(prices, 50, i),
      ma200: sma(prices, 200, i),
      high365: hl.high,
      low365: hl.low,
      rsi14: rsi(prices, 14, i),
      // Activity is never backfilled — it is a live-only flow (no honest history).
      activityScore: null,
      // circ series up to this day → annual inflation as of day i
      circSeries: circSeries.filter((c) => c.t <= ts),
      tvlNow, tvl30dAgo, holdersRevenue,
      circSupply, totalSupply,
      hasDefiSlug: !!t.defillama_slug,
      hasDefiChain: !!t.defillama_chain,
      supplyMechanism: t.supply_mechanism || 'none',
      category: t.category || 'defi',
    };
    const r = buildReading(inputs);
    // Skip thin early readings whose only signal is the short-window below-high.
    const hasOtherSignal = r.score_price_ma != null || r.score_rsi != null ||
      r.score_tvl_rev != null || r.score_emissions != null;
    if (r.final_score == null || !hasOtherSignal) continue;

    rows.push({
      token_id: t.id,
      fetched_at: dayStartUtcIso(ts),
      source_tier: 'backfill',
      final_score: r.final_score,
      score_price_ma: r.score_price_ma,
      score_below_high: r.score_below_high,
      score_rsi: r.score_rsi,
      score_tvl_rev: r.score_tvl_rev,
      score_emissions: r.score_emissions,
      score_fundamentals: r.score_fundamentals,
      score_technicals: r.score_technicals,
      score_activity: r.score_activity,        // null — activity is not backfilled
      price: inputs.price,
      ma_50: inputs.ma50,
      ma_200: inputs.ma200,
      rsi_14: inputs.rsi14,
      dist_from_low_pct: r.dist_from_low_pct,
      tvl: tvlNow,
      holders_revenue: holdersRevenue,
      circ_supply: circSupply,
      emissions_rate: r.emissions_rate,
      stochrsi_14: stochSeries[i] == null ? null : Math.round(stochSeries[i] * 10) / 10,
      macd_line: macd.line[i],
      macd_signal: macd.signal[i],
      macd_histogram: macd.hist[i],
      active_addresses: null,                  // honest gap: no historical activity
      holder_count: null,
      transfer_count: null,
      reweighted: r.reweighted,
      is_backfill: true,
    });
  }

  // Insert in batches to stay under request-size limits.
  for (let i = 0; i < rows.length; i += 100) {
    await sbInsert(base, serviceKey, 'score_readings', rows.slice(i, i + 100));
  }
  return {
    symbol: t.symbol,
    days_seeded: rows.length,
    reweighted: rows.length ? rows[rows.length - 1].reweighted : null,
  };
}
