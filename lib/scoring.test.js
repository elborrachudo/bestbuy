// lib/scoring.test.js — hand-checked unit tests for the pure scoring layer.
// Run: `node lib/scoring.test.js`  (or `npm test`). No deps; exits non-zero on fail.

import {
  scorePriceVsMas, scoreBelowHigh, scoreRsi, scoreTvlRevenue, scoreEmissions,
  computeFinalScore, verdict, buildReading, sma, rsi, highLow,
} from './scoring.js';

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

// ── Combine + verdict ─────────────────────────────────────────────────────────
console.log('\ncombine + verdict');
ok('full weights all-10 = 10', computeFinalScore({ priceMa:10, belowHigh:10, rsi:10, tvlRev:10, emissions:10 }, false) === 10);
ok('reweighted ignores tvl/emissions',
   computeFinalScore({ priceMa:10, belowHigh:10, rsi:10, tvlRev:0, emissions:0 }, true) === 10);
ok('verdict 8.5 = STRONG BUY', verdict(8.5).label === 'STRONG BUY');
ok('verdict 7.0 = BUY', verdict(7.0).label === 'BUY');
ok('verdict 5.0 = NEUTRAL', verdict(5.0).label === 'NEUTRAL');
ok('verdict 2.0 = AVOID', verdict(2.0).label === 'AVOID');

// ── buildReading: end-to-end hand-checked cases ───────────────────────────────
console.log('\nbuildReading');
{
  // Case A: token well above its MAs (recovering) yet still deeply below its
  // 1-year high, oversold RSI, growing TVL, low emissions → strong-buy region.
  const a = buildReading({
    price: 100, ma50: 50, ma200: 50,
    high365: 400, rsi14: 25,
    tvlNow: 150e6, tvl30dAgo: 100e6, holdersRevenue: 40e6,
    circSupply: 1e9, totalSupply: 1.02e9, hasDefiSlug: true,
  });
  console.log(`    case A final=${a.final_score} reweighted=${a.reweighted}`);
  ok('A: not reweighted (has fundamentals)', a.reweighted === false);
  ok('A: scores high (≥ 7)', a.final_score >= 7);

  // Case B: reweighted token (no slug) — fundamentals MUST be ignored / null.
  const b = buildReading({
    price: 2.5, ma50: 2.0, ma200: 1.8,
    high365: 3.0, rsi14: 55,
    tvlNow: null, tvl30dAgo: null, holdersRevenue: null,
    circSupply: 57e9, totalSupply: 100e9, hasDefiSlug: false,
  });
  console.log(`    case B final=${b.final_score} reweighted=${b.reweighted}`);
  ok('B: reweighted true', b.reweighted === true);
  ok('B: tvl sub-score null', b.score_tvl_rev === null);
  ok('B: emissions sub-score null', b.score_emissions === null);
  ok('B: final still computed', b.final_score != null);

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
