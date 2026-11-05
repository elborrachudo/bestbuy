// setup-engine.test.mjs — run with:  node --test setup-engine.test.mjs
// These tests are the acceptance criteria. Do not loosen them to make a change pass.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from './setup-engine.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b}, got ${a}`);

// ---------------------------------------------------------------------------
// Fixtures: the two worked examples from the spec
// ---------------------------------------------------------------------------

export const CRV = {
  symbol: 'CRVUSDT', timeframe: '4h', asOf: '2026-11-05',
  price: 0.2539, atr: 0.008557,
  ma: { 5: 0.26438, 10: 0.26959, 20: 0.2659, 120: 0.325348 },
  boll: { upper: 0.280699, mid: 0.2659, lower: 0.251101 },
  macd: { dif: -0.005091, dea: -0.005488, hist: 0.000397 },
  rsi: { 6: 38.05, 14: 39.87 },
  kdj: { k: 45.36, d: 55.62, j: 24.83 },
  swingSeq: null,
  levels: [
    { price: 0.2748, kind: 'swingHigh', label: 'selloff candle high' },
    { price: 0.2467, kind: 'swingLow', label: '24h low' },
    { price: 0.2436, kind: 'swingLow', label: 'report S1 (unverified)' },
    { price: 0.228, kind: 'swingLow', label: 'report S2 (unverified)' },
  ],
  ctx: { funding8h: -0.000024230, whaleLS: 1.7645 },
};

export const SOL = {
  symbol: 'SOLUSDT', timeframe: '1D', asOf: '2026-11-05',
  price: 89.81, atr: 6.0,
  ma: { 5: 93, 10: 99, 20: 104, 120: 91 },
  swingSeq: -1,
  levels: [
    [148.96, 'swingHigh', 'Jan high'], [97.68, 'swingHigh', 'Mar high'], [90.8, 'swingHigh', 'Apr high'],
    [98.4, 'swingHigh', 'May high'], [83.43, 'swingHigh', 'Jun high'], [83.97, 'swingHigh', 'Jul high'],
    [110.66, 'swingHigh', 'Aug high'], [124.97, 'swingHigh', 'Sep high'], [123.79, 'swingHigh', 'Oct high'],
    [109.15, 'swingHigh', 'late-Oct high'], [98.19, 'swingHigh', 'Nov high'],
    [67.46, 'swingLow', 'Feb low'], [76.75, 'swingLow', 'Mar low'], [78.55, 'swingLow', 'Apr low'],
    [79.98, 'swingLow', 'May low'], [60.17, 'swingLow', 'Jun low'], [61.14, 'swingLow', 'Jul low'],
    [70.67, 'swingLow', 'Aug low'], [95.83, 'swingLow', 'Sep low'], [101.68, 'swingLow', 'Oct structural low'],
    [92.35, 'swingLow', 'Oct low'],
  ].map(([price, kind, label]) => ({ price, kind, label })),
  ctx: {},
};

// Deterministic synthetic OHLCV (seeded LCG random walk)
function synthCandles(n = 320, seed = 7, start = 100) {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const out = [];
  let c = start;
  for (let i = 0; i < n; i++) {
    const o = c;
    c = Math.max(1, o * (1 + (rnd() - 0.5) * 0.06 + Math.sin(i / 25) * 0.004));
    const h = Math.max(o, c) * (1 + rnd() * 0.015);
    const l = Math.min(o, c) * (1 - rnd() * 0.015);
    out.push({ t: i, o, h, l, c, v: 1000 + rnd() * 500 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Indicator conventions
// ---------------------------------------------------------------------------

test('EMA and RMA of a constant are that constant', () => {
  const k = new Array(60).fill(3.5);
  assert.ok(E.ema(k, 12).slice(11).every((v) => Math.abs(v - 3.5) < 1e-12));
  assert.ok(E.rma(k, 14).slice(13).every((v) => Math.abs(v - 3.5) < 1e-12));
});

test('Bollinger: mid is SMA20 and the bands are symmetric', () => {
  const cs = synthCandles().map((k) => k.c);
  const b = E.bollinger(cs, 20, 2);
  const m = E.sma(cs, 20);
  for (let i = 19; i < cs.length; i++) {
    close(b.mid[i], m[i], 1e-12);
    close(b.upper[i] - b.mid[i], b.mid[i] - b.lower[i], 1e-9);
  }
});

test('Bollinger sample stdev is wider than population by sqrt(20/19)', () => {
  const cs = synthCandles().map((k) => k.c);
  const p = E.bollinger(cs, 20, 2, 'population');
  const s = E.bollinger(cs, 20, 2, 'sample');
  const i = 200;
  close((s.upper[i] - s.mid[i]) / (p.upper[i] - p.mid[i]), Math.sqrt(20 / 19), 1e-12);
});

test('MACD histogram is DIF - DEA (1x, not the 2x convention)', () => {
  const cs = synthCandles().map((k) => k.c);
  const m = E.macd(cs);
  let checked = 0;
  m.hist.forEach((h, i) => {
    if (h === null) return;
    close(h, m.dif[i] - m.dea[i], 1e-12);
    checked++;
  });
  assert.ok(checked > 250);
});

test('KDJ: J = 3K - 2D on every bar', () => {
  const k = synthCandles();
  const r = E.kdj(k.map((x) => x.h), k.map((x) => x.l), k.map((x) => x.c));
  r.j.forEach((j, i) => {
    if (j !== null) close(j, 3 * r.k[i] - 2 * r.d[i], 1e-9);
  });
});

test('RSI is 100 on a rising series and 0 on a falling one', () => {
  const up = Array.from({ length: 50 }, (_, i) => 10 + i);
  const dn = Array.from({ length: 50 }, (_, i) => 100 - i);
  assert.equal(E.rsi(up, 14).at(-1), 100);
  assert.equal(E.rsi(dn, 14).at(-1), 0);
});

test('ATR of bars with a constant 2.0 range and no gaps is 2.0', () => {
  const n = 40;
  const h = Array(n).fill(101);
  const l = Array(n).fill(99);
  const c = Array(n).fill(100);
  close(E.atr(h, l, c, 14).at(-1), 2, 1e-12);
});

// ---------------------------------------------------------------------------
// 2. Structure
// ---------------------------------------------------------------------------

test('fractals never use bars that have not closed yet (no lookahead)', () => {
  const k = synthCandles();
  const last = k.length - 1;
  const fr = E.fractals(k.map((x) => x.h), k.map((x) => x.l), 2, last);
  assert.ok(fr.length > 10);
  assert.ok(fr.every((f) => f.i <= last - 2));
});

test('ATR-filtered swings alternate high/low', () => {
  const k = synthCandles();
  const h = k.map((x) => x.h);
  const l = k.map((x) => x.l);
  const a = E.atr(h, l, k.map((x) => x.c), 14);
  const sw = E.filterSwings(E.fractals(h, l, 2), a, 1.5);
  assert.ok(sw.length >= 4);
  for (let i = 1; i < sw.length; i++) assert.notEqual(sw[i].type, sw[i - 1].type);
});

test('zones: merge inside 0.5 ATR, split beyond, cap width at 1 ATR', () => {
  const L = (price, w = 1) => ({ price, weight: w, kind: 'x', label: 'x' });
  const z = E.buildZones([L(100), L(100.4), L(101.5), L(104)], 1.0);
  assert.equal(z.length, 3);
  assert.deepEqual(z.map((x) => [x.low, x.high]), [[100, 100.4], [101.5, 101.5], [104, 104]]);
  const wide = E.buildZones([L(100), L(100.4), L(100.8), L(101.2), L(101.6)], 1.0);
  assert.ok(wide.every((x) => x.high - x.low <= 1.0 + 1e-9));
});

test('a lone moving average is never an entry or target zone', () => {
  const z = E.buildZones([{ price: 100, weight: 0.5, kind: 'ma20', label: 'MA20' }], 1.0);
  assert.equal(z[0].eligible, false);
});

// ---------------------------------------------------------------------------
// 3. Worked example: CRV 4h (the CoinAnk report)
// ---------------------------------------------------------------------------

test('CRV: downtrend, short retest of the MA20-MA10 cluster, pending', () => {
  const r = E.evaluate(CRV);
  assert.equal(r.regime.label, 'DOWN');
  close(r.regime.score, -0.6, 1e-9);
  assert.equal(r.decision, 'SHORT');
  const p = r.primary;
  assert.equal(p.type, 'RETEST');
  assert.equal(p.status, 'PENDING');
  close(p.fill, 0.267745, 1e-6, 'entry pivot');
  close(p.entryLow, 0.266034, 1e-6);
  close(p.entryHigh, 0.269456, 1e-6);
  close(p.stop, 0.276939, 1e-6, 'stop hops over the 0.2748 swing high');
  close(p.tp1, 0.247556, 1e-6);
  close(p.tp2, 0.228856, 1e-6);
  assert.ok(p.rr1Net >= 1.5);
  assert.ok(p.entryLow >= 0.2659 && p.entryHigh <= 0.26959, 'entry band sits inside the MA20-MA10 resistance zone');
});

test('CRV: the entry band reaches its own resistance (the report\'s did not)', () => {
  const p = E.evaluate(CRV).primary;
  assert.ok(p.entryHigh > 0.2645, 'report preferred zone topped at 0.2645, below MA20 0.2659');
});

test('CRV: stretched (oversold evidence counts), so no breakdown entry', () => {
  const r = E.evaluate(CRV);
  close(r.stretch.score, 0.5958, 5e-4);
  assert.ok(r.stretch.top.includes('macdTurn'));
  assert.ok(r.stretch.top.includes('bollPosition'));
  assert.ok(r.rejected.some((x) => x.type === 'CONTINUATION' && /chasing/.test(x.reason)));
  assert.ok(!r.candidates.some((t) => t.type === 'CONTINUATION'));
});

test('CRV: no market entry at the current price', () => {
  const r = E.evaluate(CRV);
  assert.ok(r.candidates.every((t) => t.status !== 'IN_ZONE'));
});

// ---------------------------------------------------------------------------
// 4. Worked example: SOL 1D (the screenshot)
// ---------------------------------------------------------------------------

test('SOL: short retest of the broken 95.8-99.0 zone', () => {
  const r = E.evaluate(SOL);
  assert.equal(r.regime.label, 'DOWN');
  assert.equal(r.decision, 'SHORT');
  const p = r.primary;
  assert.equal(p.type, 'RETEST');
  assert.equal(p.status, 'PENDING');
  close(p.fill, 97.6889, 1e-3);
  close(p.entryLow, 96.4889, 1e-3);
  close(p.entryHigh, 98.8889, 1e-3);
  close(p.stop, 105.5, 1e-9, 'stop hops over the 101.7-104 zone');
  close(p.tp1, 84.57, 1e-9);
  close(p.tp2, 80.58, 1e-9);
  close(p.rr1Net, 1.6464, 1e-3);
});

test('SOL: the nearer retest at ~91.5 is rejected on R:R', () => {
  const r = E.evaluate(SOL);
  const near = r.candidates.find((t) => Math.abs(t.fill - 91.46) < 0.01);
  assert.ok(near, 'candidate evaluated');
  assert.equal(near.passed, false);
  assert.ok(near.rr1Net < 1.5);
  close(near.stop, 105.5, 1e-9);
  assert.equal(near.hops, 2);
});

test('SOL: sizing at 10,000 equity and 1% risk', () => {
  const r = E.evaluate(SOL, { account: { equity: 10000, riskPct: 0.01 } });
  const s = r.sizing;
  close(s.riskUsd, 100, 1e-9);
  close(s.qty, 12.638, 1e-3);
  assert.equal(s.maxSafeLeverage, 6);
  assert.equal(s.liqClearOfStop, true);
  assert.ok(s.liquidation >= 105.5 + 6.0);
});

// ---------------------------------------------------------------------------
// 5. Symmetry: a mirrored market must give the mirrored trade
// ---------------------------------------------------------------------------

function mirror(snap, M) {
  const r = (v) => (typeof v === 'number' ? 2 * M - v : v);
  return {
    ...snap,
    price: r(snap.price),
    ma: Object.fromEntries(Object.entries(snap.ma).map(([k, v]) => [k, r(v)])),
    boll: snap.boll && { upper: r(snap.boll.lower), mid: r(snap.boll.mid), lower: r(snap.boll.upper) },
    macd: snap.macd && { dif: -snap.macd.dif, dea: -snap.macd.dea, hist: -snap.macd.hist },
    rsi: snap.rsi && Object.fromEntries(Object.entries(snap.rsi).map(([k, v]) => [k, 100 - v])),
    kdj: snap.kdj && { k: 100 - snap.kdj.k, d: 100 - snap.kdj.d, j: 100 - snap.kdj.j },
    swingSeq: snap.swingSeq == null ? snap.swingSeq : -snap.swingSeq,
    levels: snap.levels.map((l) => ({ ...l, price: r(l.price), kind: l.kind === 'swingHigh' ? 'swingLow' : 'swingHigh' })),
    ctx: {
      funding8h: snap.ctx.funding8h == null ? undefined : -snap.ctx.funding8h,
      whaleLS: snap.ctx.whaleLS == null ? undefined : 1 / snap.ctx.whaleLS,
    },
  };
}

for (const [name, snap, M] of [['CRV', CRV, 0.3], ['SOL', SOL, 120]]) {
  test(`symmetry: mirrored ${name} gives the mirrored LONG`, () => {
    const cfg = { feeRate: 0 };
    const a = E.evaluate(snap, { config: cfg });
    const b = E.evaluate(mirror(snap, M), { config: cfg });
    assert.equal(a.decision, 'SHORT');
    assert.equal(b.decision, 'LONG');
    close(b.stretch.score, a.stretch.score, 1e-9, 'stretch');
    const tol = 1e-9 * M * 10;
    close(b.primary.fill, 2 * M - a.primary.fill, tol, 'entry');
    close(b.primary.entryLow, 2 * M - a.primary.entryHigh, tol, 'entry band');
    close(b.primary.stop, 2 * M - a.primary.stop, tol, 'stop');
    close(b.primary.tp1, 2 * M - a.primary.tp1, tol, 'tp1');
    close(b.primary.tp2, 2 * M - a.primary.tp2, tol, 'tp2');
    close(b.primary.rr1Net, a.primary.rr1Net, 1e-9, 'R:R');
  });
}

// ---------------------------------------------------------------------------
// 6. Other paths
// ---------------------------------------------------------------------------

test('no trend means no trade', () => {
  const r = E.evaluate({
    price: 100, atr: 2,
    ma: { 5: 99, 10: 101, 20: 99.5, 120: 100.5 },
    macd: { dif: 0.1, dea: 0.05, hist: 0.05 },
    swingSeq: 0,
    levels: [{ price: 96, kind: 'swingLow' }, { price: 105, kind: 'swingHigh' }],
  });
  assert.equal(r.regime.label, 'RANGE');
  assert.equal(r.decision, 'NO_TRADE');
  assert.equal(r.primary, null);
});

test('an unstretched downtrend also evaluates a breakdown entry', () => {
  const r = E.evaluate({
    price: 100, atr: 2,
    ma: { 5: 101, 10: 102, 20: 103, 120: 110 },
    boll: { upper: 108, mid: 103, lower: 98 },
    macd: { dif: -1, dea: -0.8, hist: -0.2 },
    rsi: { 14: 45 }, kdj: { k: 45, d: 47, j: 41 },
    swingSeq: -1,
    levels: [
      { price: 104.5, kind: 'swingHigh' }, { price: 112, kind: 'swingHigh' },
      { price: 97, kind: 'swingLow' }, { price: 92, kind: 'swingLow' }, { price: 88, kind: 'swingLow' },
    ],
  });
  assert.ok(r.stretch.score < 0.35);
  const c = r.candidates.find((t) => t.type === 'CONTINUATION');
  assert.ok(c, 'continuation evaluated');
  assert.equal(c.status, 'CONDITIONAL');
  close(c.trigger, 96.8, 1e-9);
  close(c.fill, 96.6, 1e-9);
  close(c.stop, 98.6, 1e-9);
  assert.equal(c.passed, true);
  assert.ok(r.primary && r.alternate, 'two passing setups: primary and alternate');
});

test('analyze() runs end to end on candles', () => {
  const r = E.analyze(synthCandles(), { symbol: 'TEST', timeframe: '4h', account: { equity: 1000 } });
  assert.ok(['LONG', 'SHORT', 'NO_TRADE'].includes(r.decision));
  assert.ok(r.snapshot.levels.length > 0);
  assert.ok(r.display);
});

test('analyze() refuses too little history', () => {
  assert.throws(() => E.analyze(synthCandles(100)), /at least 150/);
});

// ---------------------------------------------------------------------------
// 7. Narrative number check
// ---------------------------------------------------------------------------

test('validator accepts engine numbers and catches invented ones', () => {
  const r = E.evaluate(CRV);
  const d = r.display.primary;
  const good = `CRVUSDT 4h: SHORT. Sell ${d.entryLow}-${d.entryHigh}, stop ${d.stop}, TP1 ${d.tp1} (R:R ${d.rr1Net}), TP2 ${d.tp2}. Stretch ${r.display.stretch.score}.`;
  assert.deepEqual(E.validateNarrative(good, r), { ok: true, unknown: [] });
  const bad = `${good} Expect a move to 0.2180.`;
  const v = E.validateNarrative(bad, r);
  assert.equal(v.ok, false);
  assert.deepEqual(v.unknown, ['0.2180']);
});
