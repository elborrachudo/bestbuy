// lib/signals.test.js — unit tests for the confluence indicators + signals layer.
// Run: `node lib/signals.test.js`. No deps; exits non-zero on failure.

import { emaSeries, macdSeries, stochRsiSeries, confluenceAt, rsiSeries } from './scoring.js';
import {
  thresholds, stochAligned, macdAligned, belowHighAligned,
  signalConfidence, strengthBand, generateSignals, detectLiveSignal,
} from './signals.js';
import { classifyLatest, classifySeries, phaseAllowsBuy, phaseAllowsSell, m2MetricsAsOf } from './cycle.js';
import { structuralDeclineSeries, structuralDeclineLatest } from './survivorship.js';
import { phaseSizeMult } from './signals.js';

let passed = 0, failed = 0;
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}  ${detail}`); }
}
const near = (a, b, eps = 1e-6) => a != null && Math.abs(a - b) <= eps;

console.log('signals.js unit tests\n');

// ── EMA ─────────────────────────────────────────────────────────────────────
console.log('indicators');
{
  const e = emaSeries([1,2,3,4,5,6], 3);
  ok('ema null during warmup', e[0] === null && e[1] === null);
  ok('ema seeds with SMA at period-1', near(e[2], 2));           // (1+2+3)/3
  ok('ema steps forward', near(e[3], 4*0.5 + 2*0.5));            // k=0.5 → 3
}
{
  // Constant price → MACD line and histogram are 0 once warm; signal too.
  const flat = new Array(40).fill(100);
  const m = macdSeries(flat);
  ok('macd line ~0 on flat price', near(m.line[39], 0, 1e-9));
  ok('macd hist ~0 on flat price', near(m.hist[39], 0, 1e-9));
  ok('macd null during warmup (idx 10)', m.line[10] === null);
}
{
  // Rising price → MACD line positive (fast EMA above slow).
  const rising = Array.from({length: 60}, (_, i) => 100 + i);
  const m = macdSeries(rising);
  ok('macd line positive on uptrend', m.line[59] > 0);
}
{
  // StochRSI: strictly rising prices → RSI pinned at 100 → flat window → 50 (neutral).
  const rising = Array.from({length: 40}, (_, i) => 100 + i);
  const s = stochRsiSeries(rising);
  ok('stochrsi 50 when RSI window flat (all-up)', near(s[39], 50, 1e-9));
  ok('stochrsi null during warmup', s[5] === null);
}
{
  // confluenceAt returns nulls on short history, object shape otherwise.
  const c0 = confluenceAt([], 0);
  ok('confluenceAt nulls on empty', c0.macd_line === null && c0.stochrsi_14 === null);
  const long = Array.from({length: 60}, (_, i) => 100 + Math.sin(i / 3) * 5);
  const c1 = confluenceAt(long);
  ok('confluenceAt populated on long series', c1.macd_line != null && c1.macd_histogram != null);
}

// ── thresholds (§5) ───────────────────────────────────────────────────────────
console.log('\nthresholds');
ok('base thresholds 22/78 when fundamentals weak/absent',
   thresholds(null).buy === 22 && thresholds(4).sell === 78);
ok('strong fundamentals tilt to 23/77 (max ±1)',
   thresholds(8).buy === 23 && thresholds(8).sell === 77);

// ── confirmer alignment ─────────────────────────────────────────────────────
console.log('\nconfirmers');
ok('stoch BUY aligned deep in oversold zone (perto)',
   stochAligned({stochrsi_14: 0}, {stochrsi_14: 0}, 'BUY') === true);
ok('stoch SELL aligned deep in overbought zone (perto)',
   stochAligned({stochrsi_14: 100}, {stochrsi_14: 100}, 'SELL') === true);
ok('stoch BUY cross up out of oversold',
   stochAligned({stochrsi_14: 25}, {stochrsi_14: 18}, 'BUY') === true);
ok('stoch SELL cross down out of overbought',
   stochAligned({stochrsi_14: 75}, {stochrsi_14: 85}, 'SELL') === true);
ok('stoch not aligned when flat mid-range',
   stochAligned({stochrsi_14: 50}, {stochrsi_14: 50}, 'BUY') === false);
ok('macd BUY bullish cross',
   macdAligned({macd_histogram: 0.2}, {macd_histogram: -0.1}, 'BUY') === true);
ok('macd BUY near-cross (rising, still <0)',
   macdAligned({macd_histogram: -0.05}, {macd_histogram: -0.2}, 'BUY') === true);
ok('macd not aligned when falling for a BUY',
   macdAligned({macd_histogram: -0.3}, {macd_histogram: -0.1}, 'BUY') === false);
ok('below-high BUY aligned when deep below high', belowHighAligned({score_below_high: 7}, 'BUY') === true);
ok('below-high SELL aligned when near high', belowHighAligned({score_below_high: 3}, 'SELL') === true);
ok('missing confirmer → not aligned (no throw)',
   macdAligned({macd_histogram: null}, null, 'BUY') === false &&
   stochAligned({stochrsi_14: null}, null, 'BUY') === false);

// ── confidence + strength ─────────────────────────────────────────────────────
console.log('\nconfidence');
ok('base RSI-only trigger = 4.0 (fraco)', (function(){
  const r = signalConfidence({stochrsi_14: 50, macd_histogram: -0.3, score_below_high: 2}, {stochrsi_14: 50, macd_histogram: -0.1}, 'BUY');
  return r.confidence === 4.0 && r.confirmers.join('+') === 'RSI';
})());
ok('full BUY confluence clamps to 10 (forte)', (function(){
  const cur = {stochrsi_14: 25, macd_histogram: 0.2, score_below_high: 8, score_fundamentals: 8, score_activity: 8};
  const prev = {stochrsi_14: 15, macd_histogram: -0.1};
  const r = signalConfidence(cur, prev, 'BUY');
  return r.confidence === 10 && r.confirmers.includes('StochRSI') && r.confirmers.includes('MACD');
})());
ok('activity caps at +1 (never dominates)', (function(){
  // RSI(4) + activity(1) only = 5.0; activity cannot add more than 1.
  const r = signalConfidence({stochrsi_14: 50, macd_histogram: -0.3, score_below_high: 2, score_activity: 10}, {stochrsi_14: 50, macd_histogram: -0.1}, 'BUY');
  return r.confidence === 5.0;
})());
ok('fundamentals add only +0.5', (function(){
  const r = signalConfidence({stochrsi_14: 50, macd_histogram: -0.3, score_below_high: 2, score_fundamentals: 9}, {stochrsi_14: 50, macd_histogram: -0.1}, 'BUY');
  return r.confidence === 4.5;
})());
ok('strength bands 4→fraco 6→médio 8→forte',
   strengthBand(4) === 'fraco' && strengthBand(6) === 'médio' && strengthBand(8) === 'forte');

// ── generateSignals: trigger + cooldown decide COUNT ──────────────────────────
console.log('\ngenerateSignals');
{
  const D = 86400000, T0 = Date.parse('2025-01-01T00:00:00Z');
  const mk = (dayOffset, rsi) => ({
    fetched_at: new Date(T0 + dayOffset * D).toISOString(),
    rsi_14: rsi, stochrsi_14: 10, macd_histogram: 0.1,
    score_below_high: 7, score_fundamentals: null, score_activity: null, price: 1,
  });
  // Two oversold days 5 days apart → cooldown should keep only the first.
  const a = generateSignals([mk(0, 18), mk(5, 15), mk(40, 12)]);
  ok('cooldown collapses near-duplicates, keeps spaced ones', a.length === 2);
  ok('all generated are BUY here', a.every(s => s.side === 'BUY'));
  // A SELL on the same day as a BUY cooldown is independent.
  const b = generateSignals([mk(0, 18), mk(2, 85)]);
  ok('BUY and SELL cooldowns are independent', b.length === 2 && b[1].side === 'SELL');
  // No trigger when RSI is mid-range.
  ok('no signal mid-range', generateSignals([mk(0, 50), mk(10, 55)]).length === 0);
}

// ── detectLiveSignal: cooldown vs last signal date ────────────────────────────
console.log('\ndetectLiveSignal');
{
  const cur = {rsi_14: 18, stochrsi_14: 10, macd_histogram: 0.1, score_below_high: 7, score_fundamentals: null, score_activity: null, price: 1};
  const fire = detectLiveSignal(cur, null, null, null, '2025-06-01T00:00:00Z');
  ok('fires when oversold and no prior signal', fire && fire.side === 'BUY');
  const blocked = detectLiveSignal(cur, null, '2025-05-20T00:00:00Z', null, '2025-06-01T00:00:00Z');
  ok('blocked within 30d cooldown', blocked === null);
  const allowed = detectLiveSignal(cur, null, '2025-04-01T00:00:00Z', null, '2025-06-01T00:00:00Z');
  ok('allowed after 30d cooldown', allowed && allowed.side === 'BUY');
}

// ── cycle phase detector ──────────────────────────────────────────────────────
console.log('\ncycle phase (4-indicator + hysteresis)');
{
  // uptrend that has pulled ~15% back off its ATH → healthy rise (Mayer 1–2.4, not euphoria)
  const ru = Array.from({length: 150}, (_, i) => 100 + i * 1.4);
  const up = ru.concat(Array.from({length: 25}, (_, i) => ru[149] * (1 - 0.006 * (i + 1))));
  ok('healthy uptrend pulled back → rise', classifyLatest(up).phase === 'rise');
  const eup = Array.from({length: 120}, (_, i) => 100 * Math.pow(1.04, i));
  ok('parabolic (Mayer>2.4) → euphoria', classifyLatest(eup).phase === 'euphoria');
  // hot top (Mayer got >1.5) then a >20% crash → correction (fell from a hot top)
  const top = Array.from({length: 160}, (_, i) => 100 * Math.pow(1.03, i));
  const fall = Array.from({length: 40}, (_, i) => top[159] * (1 - 0.012 * (i + 1)));
  ok('hot top then crash → correction', classifyLatest(top.concat(fall)).phase === 'correction');
  // mid-descent drawdown (~-36%) STILL FALLING (mom30<0), no prior hot top → correction
  // (don't buy the knife). Above the -60% capitulation threshold, so not yet accumulation.
  const knife = Array.from({length: 120}, (_, i) => 200 - i * 0.6);
  ok('mid-descent still falling → correction', classifyLatest(knife).phase === 'correction');
  // EXTREME drawdown (~-71%) still falling → accumulation (capitulation/bottom zone) even
  // with negative momentum — validates the 2015/2018/2022-low fix over the falling-knife rule.
  const capit = Array.from({length: 120}, (_, i) => 200 - i * 1.2);
  ok('extreme drawdown (capitulation) → accumulation', classifyLatest(capit).phase === 'accumulation');
  // deep but STABILIZED (flat tail, mom30≥0) → accumulation (not correction)
  const acc = Array.from({length: 160}, (_, i) => (i < 60 ? 200 - i * 2.4 : 56));
  ok('deep but stabilized (mom30≥0) → accumulation', classifyLatest(acc).phase === 'accumulation');
  ok('confidence in [0,1]', (function(){ var c = classifyLatest(eup).confidence; return c >= 0 && c <= 1; })());
  // hysteresis: on a genuine accumulation base (price well below ATH), a 2-day euphoria
  // spike must NOT flip the committed phase (needs ≥3 consecutive days).
  const accBase = Array.from({length: 20}, () => 200).concat(Array.from({length: 100}, () => 100));
  const spk = accBase.slice(); spk[80] *= 2; spk[81] *= 2;
  ok('hysteresis: 2-day spike does not flip phase', classifySeries(spk)[81].phase === 'accumulation');
}
ok('phase gate: accumulation = buys only',
   phaseAllowsBuy('accumulation') && !phaseAllowsSell('accumulation'));
ok('phase gate: euphoria = sells only',
   !phaseAllowsBuy('euphoria') && phaseAllowsSell('euphoria'));
ok('phase gate: correction = sells only (no buying the knife)',
   !phaseAllowsBuy('correction') && phaseAllowsSell('correction'));
ok('phase gate: rise = both', phaseAllowsBuy('rise') && phaseAllowsSell('rise'));

// ── signal conditioning + position state machine ──────────────────────────────
console.log('\nconditioning + state machine');
{
  const D = 86400000, T0 = Date.parse('2025-01-01T00:00:00Z');
  const mk = (dayOffset, rsi) => ({
    fetched_at: new Date(T0 + dayOffset * D).toISOString(),
    rsi_14: rsi, stochrsi_14: 10, macd_histogram: 0.1,
    score_below_high: 7, score_fundamentals: null, score_activity: null, price: 1,
  });
  const day = (off) => new Date(T0 + off * D).toISOString().slice(0, 10);

  // No phase map → unconditioned, but the position machine still applies.
  // SELL first (offset 0) is an orphan → dropped; later BUY then SELL → 1 pair.
  const seq = [mk(0, 85), mk(40, 18), mk(80, 85)];
  const r0 = generateSignals(seq);
  ok('orphan leading SELL dropped (state machine)', r0.length === 2 && r0[0].side === 'BUY' && r0[1].side === 'SELL');

  // Phase conditioning: all days in correction → BUYs suppressed, SELLs (with a
  // position) allowed. Here a BUY would be first but correction suppresses it, so the
  // following SELL has no position → nothing fires.
  const phaseAllCorrection = {}; [0, 40, 80].forEach((o) => { phaseAllCorrection[day(o)] = 'correction'; });
  const rC = generateSignals([mk(0, 18), mk(40, 85)], phaseAllCorrection);
  ok('correction suppresses BUYs (and orphan SELL → nothing)', rC.length === 0);

  // Accumulation → BUY fires; a later SELL in accumulation is suppressed (sells off).
  const phaseAcc = {}; [0, 40].forEach((o) => { phaseAcc[day(o)] = 'accumulation'; });
  const rA = generateSignals([mk(0, 18), mk(40, 85)], phaseAcc);
  ok('accumulation: BUY fires, SELL suppressed', rA.length === 1 && rA[0].side === 'BUY' && rA[0].cycle_phase === 'accumulation');

  // Live: BUY blocked in correction; allowed in accumulation.
  const curBuy = { rsi_14: 18, stochrsi_14: 10, macd_histogram: 0.1, score_below_high: 7, score_fundamentals: null, score_activity: null, price: 1 };
  ok('live BUY blocked in correction', detectLiveSignal(curBuy, null, null, null, '2025-06-01T00:00:00Z', 'correction') === null);
  ok('live BUY allowed in accumulation', (detectLiveSignal(curBuy, null, null, null, '2025-06-01T00:00:00Z', 'accumulation') || {}).side === 'BUY');
  // Live SELL needs an open position (last BUY more recent than last SELL).
  const curSell = { rsi_14: 85, stochrsi_14: 90, macd_histogram: -0.1, score_below_high: 3, score_fundamentals: null, score_activity: null, price: 1 };
  ok('live SELL blocked without open position', detectLiveSignal(curSell, null, null, null, '2025-06-01T00:00:00Z', 'rise') === null);
  ok('live SELL fires with open position',
     (detectLiveSignal(curSell, null, '2025-04-01T00:00:00Z', null, '2025-06-01T00:00:00Z', 'rise') || {}).side === 'SELL');
}

// ── survivorship filter (§2.2) + phase sizing (§2.3) ──────────────────────────
console.log('\nsurvivorship + sizing');
{
  // prolonged decline: price under a long MA that has been falling for months → true
  const down = Array.from({length: 200}, (_, i) => 300 - i * 1.2);
  ok('prolonged decline flagged', structuralDeclineLatest(down) === true);
  // steady uptrend → never structurally declining
  const up = Array.from({length: 200}, (_, i) => 100 + i * 1.2);
  ok('uptrend not flagged', structuralDeclineLatest(up) === false);
  ok('warmup is honest false', structuralDeclineSeries(down)[0] === false);

  // a structurally-declining asset has its BUY suppressed even when phase allows it
  const D = 86400000, T0 = Date.parse('2025-01-01T00:00:00Z');
  const mkBuy = (off, decline) => ({
    fetched_at: new Date(T0 + off * D).toISOString(), rsi_14: 18, stochrsi_14: 10, macd_histogram: 0.1,
    score_below_high: 7, score_fundamentals: null, score_activity: null, price: 1, structural_decline: decline,
  });
  ok('survivorship suppresses BUY for a structural decliner', generateSignals([mkBuy(0, true)]).length === 0);
  ok('healthy asset BUY still fires', generateSignals([mkBuy(0, false)]).length === 1);

  // sizing multipliers
  ok('sizing: BUY bigger in accumulation', phaseSizeMult('accumulation', 'BUY') === 1.5);
  ok('sizing: BUY normal in rise', phaseSizeMult('rise', 'BUY') === 1.0);
  ok('sizing: SELL partial in euphoria', phaseSizeMult('euphoria', 'SELL') === 0.5);
  ok('sizing: SELL full otherwise', phaseSizeMult('correction', 'SELL') === 1.0);

  // M2 liquidity confirmer (§2.1)
  const m2 = []; for (let mo = 0; mo < 24; mo++) { const d = new Date(Date.UTC(2024, mo, 1)); m2.push({ date: d.toISOString().slice(0, 10), value: 1000 * (1 + mo * 0.01) }); }
  const r = m2MetricsAsOf(m2, '2025-12-15');
  ok('M2 as-of: latest ≤ date, YoY>0 & expanding on growth', r != null && r.m2_expanding === true && r.m2_yoy_pct > 0);
  ok('M2 null before any data', m2MetricsAsOf(m2, '2023-01-01') === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
