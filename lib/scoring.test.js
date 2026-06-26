// lib/scoring.test.js — hand-checked unit tests for the pure scoring layer.
// Run: `node lib/scoring.test.js`  (or `npm test`). No deps; exits non-zero on fail.

import {
  scorePriceVsMas, scoreBelowHigh, scoreRsi, scoreTvlRevenue, scoreEmissions,
  annualInflation, annualInflationAt,
  weightedBlend, applySupplyModifier, scoreFundamentals, scoreTechnicals, scoreActivity, blendPillars,
  scoreValuationMultiple, scoreTvl, categoryValueScore,
  computeFinalScore, verdict, buildReading, sma, rsi, highLow,
} from './scoring.js';

const NOW = 1750000000000, D = 86400000;
const circSeries = (pastCirc, nowCirc, days) => [{ t: NOW - days * D, circ: pastCirc }, { t: NOW, circ: nowCirc }];

let passed = 0, failed = 0;
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}  ${detail}`); }
}
const near = (a, b, eps = 0.05) => a != null && Math.abs(a - b) <= eps;

console.log('scoring.js unit tests\n');

// ── Indicators ────────────────────────────────────────────────────────────────
console.log('indicators');
ok('sma of 1..10 (period 5) = 8', near(sma([1,2,3,4,5,6,7,8,9,10], 5), 8));
ok('sma null when too short', sma([1,2], 5) === null);
{
  const hl = highLow([5, 2, 9, 4, 1, 7], 6);
  ok('highLow high=9 low=1', hl.high === 9 && hl.low === 1);
}
ok('rsi of strictly rising series = 100', rsi([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15], 14) === 100);

// ── Sub-scores ────────────────────────────────────────────────────────────────
console.log('\nsub-scores');
ok('priceVsMas at the MAs = 5', near(scorePriceVsMas(100, 100, 100), 5));
ok('priceVsMas far above both = 10', near(scorePriceVsMas(300, 100, 100), 10));
ok('priceVsMas far below both ≈ 0', near(scorePriceVsMas(0.01, 100, 100), 0));
ok('priceVsMas uses only ma50 when ma200 null', near(scorePriceVsMas(200, 100, null), 10));

ok('belowHigh at the 1y high ≈ 0', near(scoreBelowHigh(150, 150), 0));
ok('belowHigh 50% below ≈ 5', near(scoreBelowHigh(75, 150), 5));
ok('belowHigh 90% below ≈ 9', near(scoreBelowHigh(15, 150), 9));

ok('rsi 30 → 8', near(scoreRsi(30), 8));
ok('rsi 50 → 5', near(scoreRsi(50), 5));
ok('rsi 70 → 2', near(scoreRsi(70), 2));
ok('rsi oversold (10) scores high', scoreRsi(10) > 8);

ok('emissions 0% → 10', near(scoreEmissions(0), 10));
ok('emissions 15% → 5', near(scoreEmissions(0.15), 5));
ok('emissions ≥30% → 0', near(scoreEmissions(0.40), 0));

ok('tvlRevenue growing + cheap scores high', scoreTvlRevenue(150e6, 100e6, 100e6, 20e6) > 7);
ok('tvlRevenue null when no inputs', scoreTvlRevenue(null, null, null, null) === null);
ok('MC/TVL cheap (MC = TVL) → 8', near(scoreTvlRevenue(100e6, null, 100e6, null), 8));
ok('MC/TVL expensive (MC = 10×TVL) → 0', scoreTvlRevenue(10e6, null, 100e6, null) === 0);
ok('tvlRev = TVL-trend alone when only TVL history present', near(scoreTvlRevenue(150e6, 100e6, null, null), 10));

console.log('\nannual inflation (emissions input)');
ok('10% supply growth over a year ≈ 0.10', near(annualInflation(circSeries(100, 110, 365)), 0.10, 0.01));
ok('net burn floored at 0', annualInflation(circSeries(110, 100, 365)) === 0);
ok('short window annualized (5% in 90d ≈ 20%/yr)', near(annualInflation(circSeries(100, 105, 90)), 0.2028, 0.01));
ok('null when < 2 points', annualInflation([{ t: NOW, circ: 100 }]) === null);
ok('annualInflationAt null at earliest point (no lookback yet)',
   annualInflationAt(circSeries(100, 110, 365), NOW - 365 * D) === null);

// ── Combine + verdict ─────────────────────────────────────────────────────────
console.log('\ncombine + verdict');
ok('full weights all-10 = 10', computeFinalScore({ priceMa:10, belowHigh:10, rsi:10, tvlRev:10, emissions:10 }, false) === 10);
ok('reweighted all-10 (incl. emissions) = 10',
   computeFinalScore({ priceMa:10, belowHigh:10, rsi:10, emissions:10 }, true) === 10);
ok('reweighted ignores tvlRev but keeps emissions',
   computeFinalScore({ priceMa:10, belowHigh:10, rsi:10, tvlRev:0, emissions:10 }, true) === 10);
ok('verdict 8.5 = STRONG BUY', verdict(8.5).label === 'STRONG BUY');
ok('verdict 7.0 = BUY', verdict(7.0).label === 'BUY');
ok('verdict 5.0 = NEUTRAL', verdict(5.0).label === 'NEUTRAL');
ok('verdict 2.0 = AVOID', verdict(2.0).label === 'AVOID');

// ── Pillars ───────────────────────────────────────────────────────────────────
console.log('\npillars');
ok('weightedBlend skips nulls & renormalizes', near(weightedBlend({ a: 10, b: null }, { a: 60, b: 40 }), 10));
ok('weightedBlend null when all missing', weightedBlend({ a: null }, { a: 60 }) === null);
ok('supply modifier ve-lock ×1.15', near(applySupplyModifier(8, 've-lock'), 9.2));
ok('supply modifier clamps to 10', applySupplyModifier(9, 've-lock') === 10);
ok('supply modifier none unchanged', applySupplyModifier(8, 'none') === 8);
ok('technicals 45/35/20 weighting', near(scoreTechnicals(10, 7.5, 8.33), 8.79, 0.05));
ok('blend drops null activity (F+T)', near(blendPillars(6.6, 8.79, null), 7.6, 0.05));
ok('blend technicals-only when fundamentals null', blendPillars(null, 5.5, null) === 5.5);

// Activity pillar: null until two live snapshots exist; grows with holder count.
ok('activity null with no prior snapshot', scoreActivity(null, { holder_count: 1000, transfer_count: 5000 }, 0.33) === null);
ok('activity null when interval invalid', scoreActivity({ holder_count: 1 }, { holder_count: 2 }, 0) === null);
{
  const a = scoreActivity(
    { holder_count: 1000, transfer_count: 10000, active_addresses: null },
    { holder_count: 1010, transfer_count: 10500, active_addresses: null }, 0.33);
  ok('activity scored from holder growth + transfer flow', a != null && a > 0 && a <= 10);
}

// ── Fundamentals: valuation multiple + category-aware scoring ──────────────────
console.log('\nfundamentals (category-aware)');
// Valuation multiple (mcap ÷ annual value), log-scaled: ≤10x→10, 100x→5, ≥1000x→0.
ok('valuation 10x → 10 (cheap)', near(scoreValuationMultiple(100, 10), 10));
ok('valuation 100x → 5 (fair)', near(scoreValuationMultiple(100, 1), 5));
ok('valuation 1000x → 0 (expensive)', near(scoreValuationMultiple(1000, 1), 0));
ok('valuation <10x clamps to 10', near(scoreValuationMultiple(50, 10), 10));
ok('valuation null when no revenue', scoreValuationMultiple(100, null) === null);
ok('valuation null when no mcap', scoreValuationMultiple(null, 10) === null);

// scoreTvl: 30d trend (50%) + MC/TVL cheapness (50%); no revenue here.
ok('tvl trend +50% & MC=TVL → 9', near(scoreTvl(100e6, 0.5, 100e6), 9));
ok('tvl null when no tvl/trend', scoreTvl(null, null, null) === null);
ok('tvl trend-only when no mcap', near(scoreTvl(null, 0.5, null), 10));

// categoryValueScore: payment/uncovered → null; ai-agent/infra/l1 → revenue only.
ok('payment value null', categoryValueScore('payment', { mcap: 100, annualRevenue: 1 }) === null);
ok('uncovered value null', categoryValueScore('uncovered', { mcap: 100, annualRevenue: 1 }) === null);
ok('ai-agent ignores TVL, uses revenue multiple',
   near(categoryValueScore('ai-agent', { mcap: 100, annualRevenue: 1, tvl: 999e9, tvlTrend30d: 0.5 }), 5));
ok('l1 uses chain-fee multiple', near(categoryValueScore('l1', { mcap: 1000, annualRevenue: 1 }), 0));
ok('defi merges valuation + TVL',
   categoryValueScore('defi', { mcap: 100e6, annualRevenue: 40e6, tvl: 150e6, tvlTrend30d: 0.5 }) > 7);

// scoreFundamentals(category, inputs): blends value (60) + emissions (40), coverage shrink.
ok('fundamentals payment/uncovered → null',
   scoreFundamentals('payment', { emissions: 9 }) === null &&
   scoreFundamentals('uncovered', { emissions: 9 }) === null);
ok('fundamentals ai-agent value 5 + emissions 9 (full) → 6.6',
   near(scoreFundamentals('ai-agent', { mcap: 100, annualRevenue: 1, emissions: 9, supplyMechanism: 'none' }), 6.6));
// Emissions-only (no value metric resolvable): shrinks halfway to the neutral 5.0.
ok('emissions-only fundamentals shrink halfway to neutral (9 → 7)',
   near(scoreFundamentals('ai-agent', { mcap: 100, annualRevenue: null, emissions: 9, supplyMechanism: 'none' }), 7.0));
ok('fundamentals null when value & emissions both absent',
   scoreFundamentals('ai-agent', { mcap: 100, annualRevenue: null, emissions: null }) === null);
ok('fundamentals ve-lock boosts emissions',
   scoreFundamentals('defi', { mcap: 100e6, annualRevenue: 40e6, tvl: 150e6, tvlTrend30d: 0.5, emissions: 8, supplyMechanism: 've-lock' }) >
   scoreFundamentals('defi', { mcap: 100e6, annualRevenue: 40e6, tvl: 150e6, tvlTrend30d: 0.5, emissions: 8, supplyMechanism: 'none' }));

// ── buildReading: end-to-end hand-checked cases ───────────────────────────────
console.log('\nbuildReading');
{
  // Case A: cheap DeFi token (MC < TVL, low MC/revenue multiple) well above its MAs
  // yet deeply below its 1-year high, oversold RSI, growing TVL → strong-buy region.
  const a = buildReading({
    price: 100, ma50: 50, ma200: 50,
    high365: 400, rsi14: 25,
    circSeries: circSeries(100, 103, 365), // ~3% annual inflation → emissions scores high
    tvlNow: 150e6, tvl30dAgo: 100e6, holdersRevenue: 40e6,
    circSupply: 1e6, totalSupply: 1.02e6, category: 'defi',
  });
  console.log(`    case A final=${a.final_score} F=${a.score_fundamentals} T=${a.score_technicals}`);
  ok('A: not reweighted (has fundamentals)', a.reweighted === false);
  ok('A: both pillars present', a.score_fundamentals != null && a.score_technicals != null);
  ok('A: activity pillar null (no live snapshots yet)', a.score_activity === null);
  ok('A: scores high (≥ 7)', a.final_score >= 7);

  // Case B: DeFi token with no TVL/revenue resolvable but emissions present → value
  // score null, fundamentals = emissions-only shrunk halfway to neutral (NOT null,
  // so NOT reweighted; the pillar is still covered by the supply axis).
  const b = buildReading({
    price: 2.5, ma50: 2.0, ma200: 1.8,
    high365: 3.0, rsi14: 55,
    circSeries: circSeries(100, 110, 365), // 10% annual inflation
    tvlNow: null, tvl30dAgo: null, holdersRevenue: null,
    circSupply: 57e9, totalSupply: 100e9, category: 'defi',
  });
  console.log(`    case B final=${b.final_score} reweighted=${b.reweighted} emissions=${b.score_emissions}`);
  ok('B: not reweighted (emissions-only fundamentals present)', b.reweighted === false);
  ok('B: value sub-score null (no TVL/revenue)', b.score_tvl_rev === null);
  ok('B: fundamentals shrunk toward 5 by coverage (not raw emissions)',
     b.score_fundamentals != null &&
     Math.abs(b.score_fundamentals - 5) < Math.abs(Number(b.score_emissions) - 5));
  ok('B: technicals pillar present', b.score_technicals != null);
  ok('B: emissions scored from circ-series inflation', b.score_emissions != null);
  ok('B: activity null (no live snapshots)', b.score_activity === null);
  ok('B: final blends F + T (not technicals only)', b.final_score != null && b.final_score !== b.score_technicals);

  // Case C: covered category but every value AND emissions input absent → fundamentals
  // null → auto-reweight (score then comes from Technicals).
  const c = buildReading({
    price: 1, ma50: 1, ma200: 1, high365: 2, rsi14: 50,
    tvlNow: null, tvl30dAgo: null, holdersRevenue: null,
    circSupply: 1e9, totalSupply: 1.1e9, category: 'defi',
  });
  ok('C: auto-reweight when fundamentals absent', c.reweighted === true && c.score_tvl_rev === null);

  // Case D: native L1 token — scored on chain fees (annualRevenue) via the valuation
  // multiple, not third-party TVL → real Fundamentals, not capped at neutral.
  const d = buildReading({
    price: 3000, ma50: 2800, ma200: 2500, high365: 4000, rsi14: 50,
    circSeries: circSeries(100, 100, 365),
    tvlNow: 60e9, tvl30dAgo: 55e9, holdersRevenue: 3e9,
    circSupply: 120e6, category: 'l1',
  });
  ok('D: chain-level token not reweighted (has fundamentals)', d.reweighted === false);
  ok('D: chain-level fundamentals present, not capped at neutral', d.score_fundamentals != null && d.score_fundamentals > 5);

  // Case E: payment token (XRP-like) → fundamentals fully null by category →
  // reweighted; final score comes from Technicals (+ Activity when live) only.
  const e = buildReading({
    price: 0.5, ma50: 0.55, ma200: 0.6, high365: 1.0, rsi14: 45,
    circSeries: circSeries(100, 100, 365),
    tvlNow: 35e6, tvl30dAgo: 34e6, holdersRevenue: 5e6,
    circSupply: 57e9, totalSupply: 100e9, category: 'payment',
  });
  ok('E: payment fundamentals null (reweighted)', e.score_fundamentals === null && e.reweighted === true);
  ok('E: final equals technicals-only (no F, no live activity)', near(e.final_score, e.score_technicals, 0.05));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
