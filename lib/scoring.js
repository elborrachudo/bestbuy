// lib/scoring.js — PURE scoring + indicator math. No I/O. Shared by cron-fetch,
// backfill, and the test runner. Every exported function is deterministic.

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

// ── Indicators (reconstructable per-day from a daily price series) ────────────

// Simple moving average ending at endIndex (inclusive). null if not enough data.
export function sma(prices, period, endIndex = prices.length - 1) {
  if (endIndex + 1 < period) return null;
  let sum = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i++) sum += prices[i];
  return sum / period;
}

// 90d (or any window) high/low over the trailing window ending at endIndex.
export function highLow(prices, window, endIndex = prices.length - 1) {
  const start = Math.max(0, endIndex - window + 1);
  let hi = -Infinity, lo = Infinity;
  for (let i = start; i <= endIndex; i++) {
    if (prices[i] > hi) hi = prices[i];
    if (prices[i] < lo) lo = prices[i];
  }
  return { high: hi, low: lo };
}

// 14-day RSI (classic average gain/loss). null if not enough data.
export function rsi(prices, period = 14, endIndex = prices.length - 1) {
  if (endIndex < period) return null;
  let gains = 0, losses = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i++) {
    const change = prices[i] - prices[i - 1];
    if (change >= 0) gains += change; else losses -= change;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ── Confluence indicators (StochRSI, MACD) — for the graded SIGNALS layer ──────
// These are NOT part of the continuous score/pillars. They are derived from the
// same stored daily price series and persisted per reading so the signals layer
// can grade trigger strength. Honest nulls during warmup (no fabrication).

// Per-day 14d RSI series (one value per price index; null until enough history).
export function rsiSeries(prices, period = 14) {
  return prices.map((_, i) => rsi(prices, period, i));
}

// StochRSI: where the current RSI sits within its trailing `stochPeriod` range,
// 0–100. Needs a full window of non-null RSI; flat window → 50 (neutral).
export function stochRsiSeries(prices, rsiPeriod = 14, stochPeriod = 14) {
  const rs = rsiSeries(prices, rsiPeriod);
  return rs.map((v, i) => {
    if (v == null) return null;
    let lo = Infinity, hi = -Infinity;
    for (let j = i - stochPeriod + 1; j <= i; j++) {
      if (j < 0 || rs[j] == null) return null;
      if (rs[j] < lo) lo = rs[j];
      if (rs[j] > hi) hi = rs[j];
    }
    if (hi - lo === 0) return 50;
    return ((v - lo) / (hi - lo)) * 100;
  });
}

// EMA series (same length as input). null until `period` samples exist; seeded with
// the SMA of the first `period` values at index period-1, then standard EMA.
export function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// MACD(12/26/9): line = EMA12 − EMA26; signal = EMA9(line); hist = line − signal.
// Returns three same-length arrays, null during warmup. The line is contiguous
// (non-null) from index slow-1 onward, so the signal EMA seeds off that slice.
export function macdSeries(prices, fast = 12, slow = 26, signal = 9) {
  const emaFast = emaSeries(prices, fast);
  const emaSlow = emaSeries(prices, slow);
  const line = prices.map((_, i) =>
    (emaFast[i] != null && emaSlow[i] != null) ? emaFast[i] - emaSlow[i] : null);
  const firstIdx = line.findIndex((v) => v != null);
  const sig = new Array(prices.length).fill(null);
  if (firstIdx >= 0) {
    const compact = line.slice(firstIdx);            // contiguous, all non-null
    const sEma = emaSeries(compact, signal);
    for (let i = 0; i < sEma.length; i++) if (sEma[i] != null) sig[firstIdx + i] = sEma[i];
  }
  const hist = prices.map((_, i) =>
    (line[i] != null && sig[i] != null) ? line[i] - sig[i] : null);
  return { line, signal: sig, hist };
}

// Convenience: the confluence indicators at the LAST point of a price series, as a
// flat object ready to persist on a reading. All null when history is too short.
export function confluenceAt(prices, endIndex = (prices ? prices.length - 1 : -1)) {
  if (!prices || prices.length === 0 || endIndex < 0) {
    return { stochrsi_14: null, macd_line: null, macd_signal: null, macd_histogram: null };
  }
  const stoch = stochRsiSeries(prices)[endIndex];
  const m = macdSeries(prices);
  return {
    stochrsi_14: stoch == null ? null : round1(stoch),
    macd_line: m.line[endIndex],
    macd_signal: m.signal[endIndex],
    macd_histogram: m.hist[endIndex],
  };
}

// ── Sub-scores, each normalized to 0–10 ───────────────────────────────────────

// 1. Price vs MAs. Each MA contributes a 0..1 proximity term; above by ≥100% → 1,
//    at the MA → 0.5, below by ≥100% → 0. Averaged over available MAs, ×10.
export function scorePriceVsMas(price, ma50, ma200) {
  if (price == null) return null;
  const comp = (ma) => (ma == null || ma <= 0) ? null : (clamp((price - ma) / ma, -1, 1) + 1) / 2;
  const parts = [comp(ma50), comp(ma200)].filter((v) => v != null);
  if (!parts.length) return null;
  const avg = parts.reduce((a, b) => a + b, 0) / parts.length;
  return clamp(avg * 10, 0, 10);
}

// 2. % below the trailing 1-year high — deeper drawdown = cheaper = higher.
//    Value/contrarian axis. score = 10 × (high − price)/high, so at the 1y high → 0,
//    50% below → 5, 90% below → 9.
export function scoreBelowHigh(price, high) {
  if (price == null || high == null || high <= 0) return null;
  return clamp(10 * (high - price) / high, 0, 10);
}

// 3. RSI (14d) — oversold scores high. Piecewise-linear 0→10, 30→8, 50→5, 70→2, 100→0.
export function scoreRsi(rsiVal) {
  if (rsiVal == null) return null;
  const pts = [[0, 10], [30, 8], [50, 5], [70, 2], [100, 0]];
  const x = clamp(rsiVal, 0, 100);
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    if (x >= x0 && x <= x1) {
      const t = (x - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return 5;
}

// 4. TVL + valuation. Weighted blend of three signals (any missing one drops and the
//    rest renormalize):
//    (a) 30-day TVL TREND — adoption momentum: -50% → 0, flat → 5, +50%+ → 10.   [40%]
//    (b) Market-cap ÷ TVL — how cheap the token is vs the capital locked in it; this
//        is the direct "TVL influences price" valuation. MC/TVL 0 → 10, 2.5 → 5,
//        ≥5 → 0.                                                                   [30%]
//    (c) Market-cap ÷ annual revenue multiple — cheap vs earnings: 0 → 10, 100× → 0. [30%]
export const W_TVL_REV = { trend: 40, mcTvl: 30, mcRev: 30 };
const MCTVL_ZERO_AT = 5;   // MC/TVL at which the cheapness score hits 0 (tunable)
export function scoreTvlRevenue(tvlNow, tvl30dAgo, marketCap, annualHoldersRevenue) {
  let trend = null;
  if (tvlNow != null && tvl30dAgo != null && tvl30dAgo > 0) {
    const pctChange = (tvlNow - tvl30dAgo) / tvl30dAgo;
    trend = clamp(5 + (pctChange / 0.5) * 5, 0, 10);
  }
  let mcTvl = null;
  if (marketCap != null && tvlNow != null && tvlNow > 0) {
    mcTvl = clamp(10 * (1 - (marketCap / tvlNow) / MCTVL_ZERO_AT), 0, 10);
  }
  let mcRev = null;
  if (marketCap != null && annualHoldersRevenue != null && annualHoldersRevenue > 0) {
    mcRev = clamp(10 * (1 - (marketCap / annualHoldersRevenue) / 100), 0, 10);
  }
  return weightedBlend({ trend, mcTvl, mcRev }, W_TVL_REV);
}

// 5. Emissions vs supply — low inflation scores high. 0% → 10, ≥30%/yr → ~0.
//    Input is a REAL annual inflation rate (a flow), not a supply overhang.
export function scoreEmissions(emissionsRate) {
  if (emissionsRate == null) return null;
  return clamp(10 * (1 - emissionsRate / 0.30), 0, 10);
}

// Annual inflation as of reference time `nowT`, from a reconstructed circulating-
// supply series [{ t(ms), circ }] (oldest→newest). Compares circ at `nowT` to circ
// ~365d earlier. When less than a year of history exists, uses the oldest point and
// annualizes the partial-window change. Negative (net burns) is floored at 0 → 10.
const YEAR_MS = 365 * 24 * 3600 * 1000;
export function annualInflationAt(circSeries, nowT) {
  if (!circSeries || circSeries.length < 2) return null;
  let nowPt = null;
  for (const p of circSeries) { if (p.t <= nowT) nowPt = p; else break; }
  if (!nowPt || !(nowPt.circ > 0)) return null;
  const target = nowPt.t - YEAR_MS;
  let past = null;
  for (const p of circSeries) { if (p.t <= target) past = p; else break; }
  if (!past) past = circSeries[0];            // shorter window → oldest available point
  if (!past || !(past.circ > 0) || past.t >= nowPt.t) return null;
  const days = (nowPt.t - past.t) / (24 * 3600 * 1000);
  if (days < 1) return null;
  const periodInfl = (nowPt.circ - past.circ) / past.circ;
  const annual = days >= 360 ? periodInfl : periodInfl * (365 / days);
  return Math.max(0, annual);
}

// Convenience: annual inflation as of the latest point in the series.
export function annualInflation(circSeries) {
  if (!circSeries || !circSeries.length) return null;
  return annualInflationAt(circSeries, circSeries[circSeries.length - 1].t);
}

// ── Weights + combine ─────────────────────────────────────────────────────────

export const WEIGHTS_FULL = { priceMa: 25, belowHigh: 20, rsi: 15, tvlRev: 25, emissions: 15 };
// Reweighted = no DeFi TVL/revenue. Emissions is supply-based, so it still
// applies here (skipped automatically when supply data is missing).
export const WEIGHTS_REWEIGHTED = { priceMa: 38, belowHigh: 30, rsi: 22, emissions: 10 };

// Weighted average over the sub-scores that exist; renormalizes by the weights
// actually used so a missing sub-score never silently drags the total to 0.
export function computeFinalScore(subs, reweighted) {
  const w = reweighted ? WEIGHTS_REWEIGHTED : WEIGHTS_FULL;
  let total = 0, wsum = 0;
  for (const k of Object.keys(w)) {
    if (subs[k] == null) continue;
    total += w[k] * subs[k];
    wsum += w[k];
  }
  if (wsum === 0) return null;
  return round1(total / wsum);
}

// ── Pillars ───────────────────────────────────────────────────────────────────
// Three weighted pillars on top of the sub-scores: Fundamentals, Technicals,
// Activity (on-chain adoption — replaces the old stubbed Sentiment slot).
export const W_FUNDAMENTALS = { tvlRev: 60, emissions: 40 };
export const W_TECHNICALS   = { priceMa: 45, belowHigh: 35, rsi: 20 };
export const W_ACTIVITY     = { active: 40, holders: 35, transfers: 25 };
export const W_PILLARS      = { fundamentals: 45, technicals: 35, activity: 20 };

// Weighted average over present (non-null) keys; null when none are present.
// Missing keys drop and the remaining weights renormalize.
export function weightedBlend(values, weights) {
  let total = 0, wsum = 0;
  for (const k of Object.keys(weights)) {
    if (values[k] == null) continue;
    total += weights[k] * values[k];
    wsum += weights[k];
  }
  return wsum === 0 ? null : total / wsum;
}

// Supply-mechanism modifier: a structural sink (ve-lock / burn) nudges the
// emissions sub-score up (×1.15, clamped to 10) to reflect issuance being partly
// offset. Lives inside the emissions slot; does not change emissions fetch logic.
export function applySupplyModifier(emissions, supplyMechanism) {
  if (emissions == null) return null;
  return (supplyMechanism === 've-lock' || supplyMechanism === 'burn')
    ? clamp(emissions * 1.15, 0, 10) : emissions;
}

// ── Fundamentals (category-aware value metric) ────────────────────────────────
// Each token category is scored on the value metric that fits it, normalized to a
// comparable scale via a valuation MULTIPLE (market_cap ÷ annual value) — so a DEX,
// an AI agent, and an L1 land on the same 0–10 axis. Replaces the old TVL-universal
// definition that made revenue-bearing-but-TVL-less tokens (e.g. VIRTUAL) look dead.

// Valuation multiple (mcap / annual value) → 0-10. Log-scaled because crypto
// multiples span ~5x to >1000x. ≤10x → 10 (cheap), 100x → 5 (fair), ≥1000x → 0.
export function scoreValuationMultiple(mcap, annualValue) {
  if (annualValue == null || annualValue <= 0 || mcap == null || mcap <= 0) return null;
  const x = clamp(Math.log10(mcap / annualValue), 1, 3);   // 10x→1, 100x→2, 1000x→3
  return clamp(10 - (x - 1) * 5, 0, 10);                    // 1→10, 2→5, 3→0
}

// TVL sub-score (for categories where TVL is a real metric): 30-day trend (50%) +
// market-cap/TVL cheapness (50%). No revenue here — revenue is the valuation multiple.
export function scoreTvl(tvl, tvlTrend30d, mcap) {
  const trend = (tvlTrend30d == null) ? null : clamp(5 + (tvlTrend30d / 0.5) * 5, 0, 10);
  const mcTvl = (mcap != null && tvl != null && tvl > 0) ? clamp(10 * (1 - (mcap / tvl) / 5), 0, 10) : null;
  return weightedBlend({ trend, mcTvl }, { trend: 50, mcTvl: 50 });
}

const mergePresent = (arr) => {
  const p = arr.filter((v) => v != null);
  return p.length ? p.reduce((a, b) => a + b, 0) / p.length : null;
};

// Per-category VALUE score (revenue/TVL valuation), before blending with emissions.
// null for payment/uncovered (no honest fundamentals) and when no value data exists.
export function categoryValueScore(category, inputs) {
  switch (category) {
    case 'payment':
    case 'uncovered':
      return null;
    case 'ai-agent':   // value = revenue only (TVL is ~0 / irrelevant)
    case 'infra':      // value = protocol revenue
    case 'l1':         // value = chain fees (annualRevenue carries chain fees)
      return scoreValuationMultiple(inputs.mcap, inputs.annualRevenue);
    case 'rwa':
    case 'yield':
    case 'defi':
    default:           // value = revenue + TVL, both relevant
      return mergePresent([
        scoreValuationMultiple(inputs.mcap, inputs.annualRevenue),
        scoreTvl(inputs.tvl, inputs.tvlTrend30d, inputs.mcap),
      ]);
  }
}

// Blend the value score with emissions (60/40), keeping the existing coverage factor
// (a single-component pillar shrinks toward the neutral 5.0).
function blendWithEmissions(valueScore, emissionsScore) {
  const present = [valueScore, emissionsScore].filter((v) => v != null).length;
  if (present === 0) return null;
  const raw = weightedBlend({ value: valueScore, emissions: emissionsScore }, { value: 60, emissions: 40 });
  const coverage = present / 2;
  return 5 + (raw - 5) * coverage;
}

// Fundamentals pillar — category-aware. `category` selects the value metric; emissions
// (supply-modifier-adjusted) is blended in as before. payment/uncovered → null (pillar
// reweight: the score then comes from Technicals + Activity).
//   inputs: { tvl, annualRevenue, mcap, emissions, supplyMechanism, tvlTrend30d }
export function scoreFundamentals(category, inputs) {
  if (category === 'payment' || category === 'uncovered') return null;
  const em = applySupplyModifier(inputs.emissions, inputs.supplyMechanism);
  return blendWithEmissions(categoryValueScore(category, inputs), em);
}

// Activity pillar (on-chain adoption). Flow measured from the delta between two
// live snapshots — there is NO honest backfill, so this is null until at least two
// live readings exist. Components (weights W_ACTIVITY): active addresses, holder
// growth, transfer flow; any missing component drops and the rest renormalize.
//   prev/cur: { active_addresses, holder_count, transfer_count } raw cumulative.
//   intervalDays: days between the two snapshots.
export function scoreActivity(prev, cur, intervalDays) {
  if (!cur || !(intervalDays > 0)) return null;
  let active = null, holders = null, transfers = null;
  // Active addresses (when a source provides it): log-scaled, ~1e5 addr/day → 10.
  if (cur.active_addresses != null && cur.active_addresses >= 0) {
    active = clamp((Math.log10(cur.active_addresses + 1) / 5) * 10, 0, 10);
  }
  // Holder growth: annualized % change in holder count, flat → 5, ±50%/yr → 10/0.
  if (prev && prev.holder_count > 0 && cur.holder_count != null) {
    const annual = ((cur.holder_count - prev.holder_count) / prev.holder_count) * (365 / intervalDays);
    holders = clamp(5 + (annual / 0.5) * 5, 0, 10);
  }
  // Transfer flow: daily transfers per holder (turnover), 100%/day → 10.
  if (prev && cur.transfer_count != null && prev.transfer_count != null && cur.holder_count > 0) {
    const txPerDay = Math.max(0, cur.transfer_count - prev.transfer_count) / intervalDays;
    transfers = clamp((txPerDay / cur.holder_count) * 10, 0, 10);
  }
  return weightedBlend({ active, holders, transfers }, W_ACTIVITY);
}

// Technicals pillar: price-vs-MAs (45%) + value/% below 1y high (35%) + RSI (20%).
export function scoreTechnicals(priceMa, belowHigh, rsi) {
  return weightedBlend({ priceMa, belowHigh, rsi }, W_TECHNICALS);
}

// Blend the three pillars (F 45 / T 35 / A 20); null pillars drop & renormalize.
// Activity is null for all historical/backfill rows (no honest backfill), so those
// rows blend on F + T exactly as before — no discontinuity at the live cut-over.
export function blendPillars(fundamentals, technicals, activity) {
  return round1(weightedBlend({ fundamentals, technicals, activity }, W_PILLARS));
}

export function verdict(score) {
  if (score == null) return { label: 'N/A', band: 'na' };
  if (score >= 8.0) return { label: 'STRONG BUY', band: 'strong' };
  if (score >= 6.5) return { label: 'BUY', band: 'buy' };
  if (score >= 4.5) return { label: 'NEUTRAL', band: 'neutral' };
  if (score >= 3.0) return { label: 'WEAK', band: 'weak' };
  return { label: 'AVOID', band: 'avoid' };
}

// ── Top-level reading builder ─────────────────────────────────────────────────
// Pure: given the resolved numeric inputs for one token at one moment, return the
// full reading object (sub-scores + final + reweight decision). Used identically
// by the live cron and by each backfilled day.
//
// inputs: { price, ma50, ma200, high365, low365, rsi14, circSeries,
//           tvlNow, tvl30dAgo, holdersRevenue, circSupply, totalSupply, hasDefiSlug,
//           activityScore }
//   circSeries: reconstructed [{ t, circ }] (oldest→newest); its LAST point is "now".
//   activityScore: pre-computed Activity pillar (0–10) or null — null for every
//                  backfill day and until two live snapshots exist.
export function buildReading(inputs) {
  const priceMa = scorePriceVsMas(inputs.price, inputs.ma50, inputs.ma200);
  const belowHigh = scoreBelowHigh(inputs.price, inputs.high365);
  const rsiS = scoreRsi(inputs.rsi14);

  // Raw archival metric (not scored): % the price sits above its trailing 1y low.
  const distFromLowPct = (inputs.price != null && inputs.low365 != null && inputs.low365 > 0)
    ? (inputs.price - inputs.low365) / inputs.low365 : null;

  const marketCap = (inputs.price != null && inputs.circSupply != null)
    ? inputs.price * inputs.circSupply : null;
  // Real annual inflation (a flow) from the reconstructed circulating-supply series,
  // NOT the supply overhang. null when there isn't enough history.
  const emissionsRate = annualInflation(inputs.circSeries);

  const emissions = scoreEmissions(emissionsRate);

  // Fundamentals is category-aware: the value metric (revenue / chain-fees / TVL) is
  // chosen by token.category and normalized via the valuation multiple. annualRevenue
  // carries protocol revenue (or chain fees for l1). TVL=0 (e.g. VIRTUAL) is fine —
  // the ai-agent/infra paths use revenue only.
  const annualRevenue = inputs.holdersRevenue;
  const tvlTrend30d = (inputs.tvlNow != null && inputs.tvl30dAgo != null && inputs.tvl30dAgo > 0)
    ? (inputs.tvlNow - inputs.tvl30dAgo) / inputs.tvl30dAgo : null;
  const valueInputs = {
    tvl: inputs.tvlNow, annualRevenue, mcap: marketCap, emissions,
    supplyMechanism: inputs.supplyMechanism, tvlTrend30d,
  };
  const valueScore = categoryValueScore(inputs.category, valueInputs);   // stored for transparency
  const fundamentals = scoreFundamentals(inputs.category, valueInputs);
  const reweighted = (fundamentals == null);

  // Three pillars, then blend. Activity comes pre-computed from on-chain snapshot
  // deltas (live only); null for backfill and until two live snapshots exist.
  const technicals = scoreTechnicals(priceMa, belowHigh, rsiS);
  const activity = inputs.activityScore == null ? null : inputs.activityScore;
  const final = blendPillars(fundamentals, technicals, activity);

  return {
    final_score: final,
    score_price_ma: round1(priceMa),
    score_below_high: round1(belowHigh),
    score_rsi: round1(rsiS),
    score_tvl_rev: round1(valueScore),
    score_emissions: round1(emissions),
    score_fundamentals: round1(fundamentals),
    score_technicals: round1(technicals),
    score_activity: round1(activity),
    dist_from_low_pct: distFromLowPct,
    emissions_rate: emissionsRate,
    market_cap: marketCap,
    reweighted,
  };
}
