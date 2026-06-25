// lib/scoring.test.js — hand-checked unit tests for the pure scoring layer.
// Run: `node lib/scoring.test.js`  (or `npm test`). No deps; exits non-zero on fail.

import {
  scorePriceVsMas, scoreBelowHigh, scoreRsi, scoreTvlRevenue, scoreEmissions,
  annualInflation, annualInflationAt,
  weightedBlend, applySupplyModifier, scoreFundamentals, scoreTechnicals, blendPillars,
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

ok('tvlRevenue growing+cheap scores high', scoreTvlRevenue(150, 100, 1e6, 1e6) > 7);
ok('tvlRevenue null when no inputs', scoreTvlRevenue(null, null, null, null) === null);

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
ok('fundamentals null when no tvlRev (market-only)', scoreFundamentals(null, 9, 'none') === null);
ok('fundamentals = 60·tvlRev + 40·emissions', near(scoreFundamentals(5, 9, 'none'), 6.6));
ok('fundamentals ve-lock boosts emissions', scoreFundamentals(5, 8, 've-lock') > scoreFundamentals(5, 8, 'none'));
ok('technicals 45/35/20 weighting', near(scoreTechnicals(10, 7.5, 8.33), 8.79, 0.05));
ok('blend drops null sentiment (F+T)', near(blendPillars(6.6, 8.79, null), 7.6, 0.05));
ok('blend technicals-only when fundamentals null', blendPillars(null, 5.5, null) === 5.5);

// ── buildReading: end-to-end hand-checked cases ───────────────────────────────
console.log('\nbuildReading');
{
  // Case A: token well above its MAs (recovering) yet still deeply below its
  // 1-year high, oversold RSI, growing TVL, low emissions → strong-buy region.
  const a = buildReading({
    price: 100, ma50: 50, ma200: 50,
    high365: 400, rsi14: 25,
    circSeries: circSeries(100, 103, 365), // ~3% annual inflation → emissions scores high
    tvlNow: 150e6, tvl30dAgo: 100e6, holdersRevenue: 40e6,
    circSupply: 1e9, totalSupply: 1.02e9, hasDefiSlug: true,
  });
  console.log(`    case A final=${a.final_score} F=${a.score_fundamentals} T=${a.score_technicals}`);
  ok('A: not reweighted (has fundamentals)', a.reweighted === false);
  ok('A: both pillars present', a.score_fundamentals != null && a.score_technicals != null);
  ok('A: sentiment pillar null (stub)', a.score_sentiment === null);
  ok('A: scores high (≥ 7)', a.final_score >= 7);

  // Case B: reweighted token (no slug) — DeFi fundamentals null, but emissions
  // still scored from the reconstructed circ series.
  const b = buildReading({
    price: 2.5, ma50: 2.0, ma200: 1.8,
    high365: 3.0, rsi14: 55,
    circSeries: circSeries(100, 110, 365), // 10% annual inflation
    tvlNow: null, tvl30dAgo: null, holdersRevenue: null,
    circSupply: 57e9, totalSupply: 100e9, hasDefiSlug: false,
  });
  console.log(`    case B final=${b.final_score} reweighted=${b.reweighted} emissions=${b.score_emissions}`);
  ok('B: reweighted true', b.reweighted === true);
  ok('B: tvl sub-score null', b.score_tvl_rev === null);
  ok('B: fundamentals pillar null (market-only)', b.score_fundamentals === null);
  ok('B: technicals pillar present', b.score_technicals != null);
  ok('B: emissions scored from circ-series inflation', b.score_emissions != null);
  ok('B: final = technicals only', b.final_score === b.score_technicals);

  // Case C: has slug but both fundamental fetches failed → auto-reweight.
  const c = buildReading({
    price: 1, ma50: 1, ma200: 1, high365: 2, rsi14: 50,
    tvlNow: null, tvl30dAgo: null, holdersRevenue: null,
    circSupply: 1e9, totalSupply: 1.1e9, hasDefiSlug: true,
  });
  ok('C: auto-reweight when fundamentals absent', c.reweighted === true && c.score_tvl_rev === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
