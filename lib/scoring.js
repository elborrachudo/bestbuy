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

// 2. Distance from 90d low — INVERTED (closer to low = higher). Value/contrarian.
export function scoreDistFromLow(price, low90, high90) {
  if (price == null || low90 == null || high90 == null || high90 <= low90) return null;
  const pct = clamp((price - low90) / (high90 - low90), 0, 1);
  return clamp(10 * (1 - pct), 0, 10);
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

// 4. TVL + holders-revenue. Average of two halves:
//    (a) 30-day TVL trend: -50% → 0, flat → 5, +50%+ → 10.
//    (b) market-cap-to-annual-holders-revenue multiple: cheaper → higher (0 → 10, 100x → 0).
export function scoreTvlRevenue(tvlNow, tvl30dAgo, marketCap, annualHoldersRevenue) {
  let trendScore = null;
  if (tvlNow != null && tvl30dAgo != null && tvl30dAgo > 0) {
    const pctChange = (tvlNow - tvl30dAgo) / tvl30dAgo;
    trendScore = clamp(5 + (pctChange / 0.5) * 5, 0, 10);
  }
  let valueScore = null;
  if (marketCap != null && annualHoldersRevenue != null && annualHoldersRevenue > 0) {
    const multiple = marketCap / annualHoldersRevenue;
    valueScore = clamp(10 * (1 - multiple / 100), 0, 10);
  }
  const parts = [trendScore, valueScore].filter((v) => v != null);
  if (!parts.length) return null;
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

// 5. Emissions vs supply — low inflation scores high. 0% → 10, ≥30%/yr → ~0.
export function scoreEmissions(emissionsRate) {
  if (emissionsRate == null) return null;
  return clamp(10 * (1 - emissionsRate / 0.30), 0, 10);
}

// ── Weights + combine ─────────────────────────────────────────────────────────

export const WEIGHTS_FULL = { priceMa: 25, distLow: 20, rsi: 15, tvlRev: 25, emissions: 15 };
export const WEIGHTS_REWEIGHTED = { priceMa: 42, distLow: 33, rsi: 25 };

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
// inputs: { price, ma50, ma200, high90, low90, rsi14,
//           tvlNow, tvl30dAgo, holdersRevenue, circSupply, totalSupply, hasDefiSlug }
export function buildReading(inputs) {
  const priceMa = scorePriceVsMas(inputs.price, inputs.ma50, inputs.ma200);
  const distLow = scoreDistFromLow(inputs.price, inputs.low90, inputs.high90);
  const rsiS = scoreRsi(inputs.rsi14);

  const marketCap = (inputs.price != null && inputs.circSupply != null)
    ? inputs.price * inputs.circSupply : null;
  const emissionsRate = (inputs.totalSupply != null && inputs.circSupply != null && inputs.circSupply > 0)
    ? Math.max(0, (inputs.totalSupply - inputs.circSupply) / inputs.circSupply) : null;

  // Auto-reweight: no slug, or no fundamental data arrived → market-only.
  let tvlRev = null, emissions = null;
  const fundamentalsAvailable = !!inputs.hasDefiSlug &&
    (inputs.tvlNow != null || inputs.holdersRevenue != null);
  if (fundamentalsAvailable) {
    tvlRev = scoreTvlRevenue(inputs.tvlNow, inputs.tvl30dAgo, marketCap, inputs.holdersRevenue);
    emissions = scoreEmissions(emissionsRate);
  }
  const reweighted = (tvlRev == null && emissions == null);

  const subs = { priceMa, distLow, rsi: rsiS, tvlRev, emissions };
  const final = computeFinalScore(subs, reweighted);

  return {
    final_score: final,
    score_price_ma: round1(priceMa),
    score_dist_low: round1(distLow),
    score_rsi: round1(rsiS),
    score_tvl_rev: round1(tvlRev),
    score_emissions: round1(emissions),
    emissions_rate: emissionsRate,
    market_cap: marketCap,
    reweighted,
  };
}
