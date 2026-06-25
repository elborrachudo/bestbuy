// lib/seed.js — shared historical-seeding for one token. Used by the full
// backfill endpoint (all tokens) and the auto-backfill-on-add endpoint (a single
// new token). Pulls up to `days` of daily price, reconstructs the price sub-scores
// per day, overlays fundamentals (per-day TVL; revenue + supply held at current),
// and inserts one is_backfill=true row per day at that day's 00:00 UTC.

import {
  getCoinGeckoPriceSeries, getCoinGeckoSupply,
  getDefiLlamaTvl, getDefiLlamaRevenueAnnual, tvlAtDate,
} from './sources.js';
import { sma, highLow, rsi, buildReading } from './scoring.js';
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

  // Fundamentals overlay: per-day TVL from history; revenue + supply at current.
  let tvlSeries = null, holdersRevenue = null, circSupply = null, totalSupply = null;
  if (t.defillama_slug) {
    try { tvlSeries = (await getDefiLlamaTvl(t.defillama_slug)).series; } catch { /* market-only day */ }
    await sleep(400);
    try { holdersRevenue = await getDefiLlamaRevenueAnnual(t.defillama_slug); } catch { /* */ }
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

    // Trailing 1-year high ending at day i (capped at available data).
    const high365 = highLow(prices, 365, i).high;
    const inputs = {
      price: prices[i],
      ma50: sma(prices, 50, i),
      ma200: sma(prices, 200, i),
      high365,
      rsi14: rsi(prices, 14, i),
      tvlNow, tvl30dAgo, holdersRevenue,
      circSupply, totalSupply,
      hasDefiSlug: !!t.defillama_slug,
    };
    const r = buildReading(inputs);
    // Skip thin early readings whose only signal is the short-window below-high.
    const hasOtherSignal = r.score_price_ma != null || r.score_rsi != null ||
      r.score_tvl_rev != null || r.score_emissions != null;
    if (r.final_score == null || !hasOtherSignal) continue;

    rows.push({
      token_id: t.id,
      fetched_at: dayStartUtcIso(ts),
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
      tvl: tvlNow,
      holders_revenue: holdersRevenue,
      circ_supply: circSupply,
      emissions_rate: r.emissions_rate,
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
