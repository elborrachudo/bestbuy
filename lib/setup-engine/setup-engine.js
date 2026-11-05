// setup-engine.js — Setup Engine v1.0, reference implementation
//
// Structure-first perp setup engine. Pure functions, zero dependencies.
// Runs in Node 18+ and in any modern browser (ES module).
//
// Two entry points:
//   analyze(candles, opts)  — full pipeline from OHLCV
//   evaluate(snapshot, opts) — decision layer only, from pre-computed values
//
// Every rule here is described in SETUP_ENGINE_SPEC.md. If the code and the
// spec ever disagree, the spec is wrong — fix the spec, not the tests.

export const VERSION = '1.0.0';

export const DEFAULTS = Object.freeze({
  // --- indicators -----------------------------------------------------------
  maPeriods: [5, 10, 20, 120],
  bollPeriod: 20,
  bollK: 2,
  bollStdev: 'population',      // TradingView default. 'sample' = most Chinese platforms.
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  rsiPeriods: [6, 14],
  kdjN: 9,
  kdjM1: 3,
  kdjM2: 3,
  atrPeriod: 14,
  minBars: 150,

  // --- structure ------------------------------------------------------------
  fractalSide: 2,               // Williams fractal: 2 bars each side (5-bar pattern)
  swingMinAtr: 1.5,             // alternating swings must differ by >= this many ATR
  zoneMergeAtr: 0.5,            // levels closer than this (ATR) join one zone
  zoneMaxWidthAtr: 1.0,         // zones wider than this are split at their largest gap
  swingWeight: 1.0,             // strength of a confirmed swing level
  dynamicWeight: 0.5,           // strength of a moving level (MA10, MA20, MA120, BOLL bands)
  minZoneStrength: 1.0,         // zones below this cannot be entries or targets

  // --- regime ---------------------------------------------------------------
  trendWeights: { maStack: 0.4, swingSeq: 0.4, macdSide: 0.2 },
  trendThreshold: 0.4,          // |trend score| below this = RANGE = NO_TRADE

  // --- stretch (how far price has already run in the trend direction) --------
  stretchWeights: {
    maDistance: 0.20, rsi: 0.15, kdjJ: 0.10, bollPosition: 0.15,
    macdTurn: 0.15, funding: 0.10, whaleSkew: 0.15,
  },
  stretchMaxForContinuation: 0.35, // at or above this, no breakout/breakdown entries
  fundingScale: 0.0005,         // |funding per 8h| that counts as fully crowded (0.05%)

  // --- entry / stop / targets -----------------------------------------------
  entryHalfWidthAtr: 0.20,      // entry band = zone pivot +/- this
  maxRetestZones: 3,            // retest candidates evaluated per run
  stopZoneBufferAtr: 0.5,       // stop sits at least this far beyond the entry zone
  stopHopBufferAtr: 0.25,       // when a stop hops over a zone, it clears it by this
  stopConflictAtr: 0.5,         // a zone this close beyond the stop forces a hop
  maxStopHops: 2,
  stopMinAtr: 1.0,
  stopMaxAtr: 2.5,
  tpFrontRunAtr: 0.10,          // targets sit this far in front of the zone edge
  tpMinDistAtr: 1.0,            // a target must be at least this far from entry
  breakTriggerAtr: 0.10,        // continuation: bar must close this far beyond the zone
  breakFillAtr: 0.20,           // continuation: assumed fill this far beyond the zone

  // --- gate / selection -----------------------------------------------------
  minRR1: 1.5,                  // net-of-fees R:R to TP1 required to trade
  fillDecayAtr: 1.5,            // selection penalty for distance (fit by backtest)
  feeRate: 0.0005,              // taker fee per side (0.05%)
  pendingBars: 12,              // a pending order expires after this many bars

  // --- sizing ---------------------------------------------------------------
  riskPct: 0.01,
  mmr: 0.005,                   // maintenance margin rate (exchange-specific)
  liqBufferAtr: 1.0,            // liquidation must sit this far beyond the stop
});

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const EPS = 1e-12;

// ============================================================================
// 1. Indicators
// ============================================================================

export function sma(src, n) {
  const out = new Array(src.length).fill(null);
  let sum = 0;
  for (let i = 0; i < src.length; i++) {
    sum += src[i];
    if (i >= n) sum -= src[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

// Exponential smoothing seeded with the SMA of the first n valid values.
// alpha = 2/(n+1) gives EMA; alpha = 1/n gives Wilder's RMA.
function smooth(src, n, alpha) {
  const out = new Array(src.length).fill(null);
  const start = src.findIndex(isNum);
  if (start < 0 || src.length - start < n) return out;
  let seed = 0;
  for (let i = start; i < start + n; i++) seed += src[i];
  let prev = seed / n;
  out[start + n - 1] = prev;
  for (let i = start + n; i < src.length; i++) {
    prev = alpha * src[i] + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}
export const ema = (src, n) => smooth(src, n, 2 / (n + 1));
export const rma = (src, n) => smooth(src, n, 1 / n);

export function rollingStdev(src, n, mode = 'population') {
  const out = new Array(src.length).fill(null);
  const div = mode === 'sample' ? n - 1 : n;
  for (let i = n - 1; i < src.length; i++) {
    let m = 0;
    for (let k = i - n + 1; k <= i; k++) m += src[k];
    m /= n;
    let ss = 0;
    for (let k = i - n + 1; k <= i; k++) ss += (src[k] - m) ** 2;
    out[i] = Math.sqrt(ss / div);
  }
  return out;
}

export function bollinger(close, n = 20, k = 2, mode = 'population') {
  const mid = sma(close, n);
  const sd = rollingStdev(close, n, mode);
  return {
    mid,
    upper: mid.map((m, i) => (isNum(m) ? m + k * sd[i] : null)),
    lower: mid.map((m, i) => (isNum(m) ? m - k * sd[i] : null)),
  };
}

// MACD with histogram = DIF - DEA (verified against the CoinAnk report;
// the Chinese 2x(DIF-DEA) convention is NOT used).
export function macd(close, fast = 12, slow = 26, signal = 9) {
  const ef = ema(close, fast);
  const es = ema(close, slow);
  const dif = close.map((_, i) => (isNum(ef[i]) && isNum(es[i]) ? ef[i] - es[i] : null));
  const dea = ema(dif, signal);
  const hist = dif.map((d, i) => (isNum(d) && isNum(dea[i]) ? d - dea[i] : null));
  return { dif, dea, hist };
}

export function rsi(close, n = 14) {
  const up = [null];
  const dn = [null];
  for (let i = 1; i < close.length; i++) {
    const d = close[i] - close[i - 1];
    up.push(Math.max(d, 0));
    dn.push(Math.max(-d, 0));
  }
  const au = rma(up, n);
  const ad = rma(dn, n);
  return au.map((u, i) => {
    if (!isNum(u) || !isNum(ad[i])) return null;
    if (ad[i] === 0) return u === 0 ? 50 : 100;
    return 100 - 100 / (1 + u / ad[i]);
  });
}

// KDJ(9,3,3): K and D start at 50; J = 3K - 2D (verified against the report).
export function kdj(high, low, close, n = 9, m1 = 3, m2 = 3) {
  const K = new Array(close.length).fill(null);
  const D = new Array(close.length).fill(null);
  const J = new Array(close.length).fill(null);
  let k = 50;
  let d = 50;
  for (let i = n - 1; i < close.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let x = i - n + 1; x <= i; x++) {
      if (high[x] > hh) hh = high[x];
      if (low[x] < ll) ll = low[x];
    }
    const rsv = hh === ll ? 50 : ((close[i] - ll) / (hh - ll)) * 100;
    k = ((m1 - 1) * k + rsv) / m1;
    d = ((m2 - 1) * d + k) / m2;
    K[i] = k;
    D[i] = d;
    J[i] = 3 * k - 2 * d;
  }
  return { k: K, d: D, j: J };
}

export function atr(high, low, close, n = 14) {
  const tr = high.map((h, i) =>
    i === 0
      ? h - low[i]
      : Math.max(h - low[i], Math.abs(h - close[i - 1]), Math.abs(low[i] - close[i - 1])),
  );
  return rma(tr, n);
}

export function computeIndicators(high, low, close, cfg = DEFAULTS) {
  const ma = {};
  for (const p of cfg.maPeriods) ma[p] = sma(close, p);
  const r = {};
  for (const p of cfg.rsiPeriods) r[p] = rsi(close, p);
  return {
    ma,
    boll: bollinger(close, cfg.bollPeriod, cfg.bollK, cfg.bollStdev),
    macd: macd(close, cfg.macdFast, cfg.macdSlow, cfg.macdSignal),
    rsi: r,
    kdj: kdj(high, low, close, cfg.kdjN, cfg.kdjM1, cfg.kdjM2),
    atr: atr(high, low, close, cfg.atrPeriod),
  };
}

// ============================================================================
// 2. Structure
// ============================================================================

// Williams fractals. A fractal at bar i is only CONFIRMED once p more bars have
// closed, so nothing within the last p bars is ever returned (no lookahead).
export function fractals(high, low, p = 2, lastIndex = high.length - 1) {
  const out = [];
  for (let i = p; i + p <= lastIndex; i++) {
    let isH = true;
    let isL = true;
    for (let k = 1; k <= p; k++) {
      if (!(high[i] > high[i - k]) || !(high[i] >= high[i + k])) isH = false;
      if (!(low[i] < low[i - k]) || !(low[i] <= low[i + k])) isL = false;
    }
    if (isH) out.push({ i, type: 'H', price: high[i] });
    if (isL) out.push({ i, type: 'L', price: low[i] });
  }
  return out;
}

// ATR-filtered zigzag: alternating swings, each at least minAtr x ATR from the
// previous one. Two highs in a row keep the higher; two lows keep the lower.
export function filterSwings(frs, atrSeries, minAtr = 1.5) {
  const s = [];
  for (const f of frs) {
    const a = atrSeries[f.i];
    if (!isNum(a)) continue;
    const last = s[s.length - 1];
    if (!last) {
      s.push({ ...f });
      continue;
    }
    if (last.type === f.type) {
      const moreExtreme = f.type === 'H' ? f.price > last.price : f.price < last.price;
      if (moreExtreme) s[s.length - 1] = { ...f };
      continue;
    }
    if (Math.abs(f.price - last.price) >= minAtr * a) s.push({ ...f });
  }
  return s;
}

// +1 = higher highs and higher lows, -1 = lower highs and lower lows,
// 0 = mixed, null = not enough swings to tell.
export function swingSequence(swings) {
  const H = swings.filter((s) => s.type === 'H');
  const L = swings.filter((s) => s.type === 'L');
  if (H.length < 2 || L.length < 2) return null;
  const hh = H[H.length - 1].price > H[H.length - 2].price;
  const hl = L[L.length - 1].price > L[L.length - 2].price;
  if (hh && hl) return 1;
  if (!hh && !hl) return -1;
  return 0;
}

// Cluster levels into zones. Single-linkage on gaps (order-independent, so the
// result is symmetric for longs and shorts), then any zone wider than the cap
// is split at its largest internal gap.
export function buildZones(levels, atrNow, cfg = DEFAULTS) {
  const pts = levels.filter((l) => isNum(l.price)).slice().sort((a, b) => a.price - b.price);
  if (!pts.length) return [];
  let groups = [[pts[0]]];
  for (let k = 1; k < pts.length; k++) {
    const g = groups[groups.length - 1];
    if (pts[k].price - g[g.length - 1].price <= cfg.zoneMergeAtr * atrNow + EPS) g.push(pts[k]);
    else groups.push([pts[k]]);
  }
  const maxW = cfg.zoneMaxWidthAtr * atrNow;
  const split = (g) => {
    if (g.length < 2 || g[g.length - 1].price - g[0].price <= maxW + EPS) return [g];
    const centre = (g[0].price + g[g.length - 1].price) / 2;
    let best = 1;
    let bestGap = -1;
    let bestDist = Infinity;
    for (let k = 1; k < g.length; k++) {
      const gap = g[k].price - g[k - 1].price;
      const dist = Math.abs((g[k].price + g[k - 1].price) / 2 - centre);
      if (gap > bestGap + EPS || (Math.abs(gap - bestGap) <= EPS && dist < bestDist)) {
        best = k;
        bestGap = gap;
        bestDist = dist;
      }
    }
    return [...split(g.slice(0, best)), ...split(g.slice(best))];
  };
  groups = groups.flatMap(split);
  return groups.map((g, idx) => {
    const w = g.reduce((s, p) => s + p.weight, 0);
    return {
      id: `Z${idx + 1}`,
      low: g[0].price,
      high: g[g.length - 1].price,
      pivot: g.reduce((s, p) => s + p.price * p.weight, 0) / w,
      strength: w,
      eligible: w >= cfg.minZoneStrength - EPS,
      members: g.map((p) => ({ price: p.price, kind: p.kind, label: p.label, weight: p.weight })),
    };
  });
}

// ============================================================================
// 3. Regime and stretch
// ============================================================================

// Missing components contribute 0, so missing data pulls toward RANGE (no trade).
export function regime(snap, cfg = DEFAULTS) {
  const c = snap.price;
  const mas = cfg.maPeriods.map((p) => snap.ma?.[p]).filter(isNum);
  const maStack = mas.length
    ? mas.reduce((a, m) => a + (c > m ? 1 : c < m ? -1 : 0), 0) / mas.length
    : null;
  const swingSeq = isNum(snap.swingSeq) ? snap.swingSeq : null;
  const macdSide = isNum(snap.macd?.dif) ? Math.sign(snap.macd.dif) : null;
  const w = cfg.trendWeights;
  const score = w.maStack * (maStack ?? 0) + w.swingSeq * (swingSeq ?? 0) + w.macdSide * (macdSide ?? 0);
  const label = score >= cfg.trendThreshold - EPS ? 'UP' : score <= -cfg.trendThreshold + EPS ? 'DOWN' : 'RANGE';
  return { label, score, components: { maStack, swingSeq, macdSide } };
}

// 0 = not stretched, 1 = fully stretched in the trend direction.
// Stretch never changes direction. It only decides entry timing:
// a stretched market gets retest entries only, never breakout/breakdown entries.
export function stretch(snap, dir, cfg = DEFAULTS) {
  const c = snap.price;
  const a = snap.atr;
  const comp = {};
  if (isNum(snap.ma?.[20]) && a > 0) comp.maDistance = clamp01((dir * (c - snap.ma[20])) / a / 3);
  if (isNum(snap.rsi?.[14])) comp.rsi = clamp01((dir * (snap.rsi[14] - 50)) / 25);
  if (isNum(snap.kdj?.j)) comp.kdjJ = clamp01((dir * (snap.kdj.j - 50)) / 50);
  const bu = snap.boll?.upper;
  const bl = snap.boll?.lower;
  if (isNum(bu) && isNum(bl) && bu > bl) comp.bollPosition = clamp01((dir * ((c - bl) / (bu - bl) - 0.5)) / 0.5);
  if (isNum(snap.macd?.hist)) comp.macdTurn = dir * snap.macd.hist < 0 ? 1 : 0;
  if (isNum(snap.ctx?.funding8h)) comp.funding = clamp01((dir * snap.ctx.funding8h) / cfg.fundingScale);
  const ls = snap.ctx?.whaleLS;
  if (isNum(ls) && ls > 0) comp.whaleSkew = clamp01(dir > 0 ? 1 / ls - 1 : ls - 1);

  const W = cfg.stretchWeights;
  let num = 0;
  let den = 0;
  for (const [k, v] of Object.entries(comp)) {
    num += W[k] * v;
    den += W[k];
  }
  const score = den > 0 ? num / den : 0;
  const top = Object.entries(comp)
    .filter(([, v]) => v >= 0.5)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 3)
    .map(([k]) => k);
  const missing = Object.keys(W).filter((k) => !(k in comp));
  return { score, components: comp, top, missing, coverage: den / Object.values(W).reduce((s, v) => s + v, 0) };
}

// ============================================================================
// 4. Trades: entry, stop, targets, gate
// ============================================================================

// Push the stop beyond any eligible zone sitting on it or just past it.
function resolveStop(start, entryZone, zones, dir, atrNow, cfg) {
  let stop = start;
  let hops = 0;
  const beyondEntry = (o) => (dir < 0 ? o.low > entryZone.high : o.high < entryZone.low);
  // A zone conflicts when it reaches within the hop buffer of the stop (strictly,
  // so a stop that has just hopped a zone does not conflict with it again) and
  // starts no further than stopConflictAtr beyond the stop.
  const conflicts = (o) =>
    dir < 0
      ? o.high > stop - cfg.stopHopBufferAtr * atrNow + EPS && o.low <= stop + cfg.stopConflictAtr * atrNow + EPS
      : o.low < stop + cfg.stopHopBufferAtr * atrNow - EPS && o.high >= stop - cfg.stopConflictAtr * atrNow - EPS;
  for (;;) {
    const cands = zones.filter((o) => o !== entryZone && o.eligible && beyondEntry(o) && conflicts(o));
    if (!cands.length) return { stop, hops, clean: true };
    if (hops >= cfg.maxStopHops) return { stop, hops, clean: false };
    const o = dir < 0 ? cands.reduce((m, z) => (z.high > m.high ? z : m)) : cands.reduce((m, z) => (z.low < m.low ? z : m));
    stop = dir < 0 ? o.high + cfg.stopHopBufferAtr * atrNow : o.low - cfg.stopHopBufferAtr * atrNow;
    hops++;
  }
}

function targets(fill, entryZone, zones, dir, atrNow, cfg) {
  const front = cfg.tpFrontRunAtr * atrNow;
  const minD = cfg.tpMinDistAtr * atrNow;
  return zones
    .filter((o) => o !== entryZone && o.eligible)
    .map((o) => ({ zone: o, price: dir < 0 ? o.high + front : o.low - front }))
    .filter((t) => (dir < 0 ? fill - t.price >= minD - EPS : t.price - fill >= minD - EPS))
    .sort((x, y) => (dir < 0 ? y.price - x.price : x.price - y.price))
    .slice(0, 2);
}

function finishTrade(t, snap, zones, dir, cfg) {
  const a = snap.atr;
  const c = snap.price;
  const fee = cfg.feeRate;
  const risk = Math.abs(t.stop - t.fill);
  t.stopAtr = risk / a;
  t.stopPct = risk / t.fill;
  const tps = targets(t.fill, t.zone, zones, dir, a, cfg);
  t.tp1 = tps[0]?.price ?? null;
  t.tp2 = tps[1]?.price ?? null;
  t.tp1Zone = tps[0]?.zone.id ?? null;
  t.tp2Zone = tps[1]?.zone.id ?? null;
  const rr = (tp) => (isNum(tp) ? Math.abs(t.fill - tp) / risk : null);
  const rrNet = (tp) =>
    isNum(tp) ? (Math.abs(t.fill - tp) - fee * (t.fill + tp)) / (risk + fee * (t.fill + t.stop)) : null;
  t.rr1 = rr(t.tp1);
  t.rr2 = rr(t.tp2);
  t.rr1Net = rrNet(t.tp1);
  t.rr2Net = rrNet(t.tp2);
  t.tp1Pct = isNum(t.tp1) ? Math.abs(t.fill - t.tp1) / t.fill : null;
  t.tp2Pct = isNum(t.tp2) ? Math.abs(t.fill - t.tp2) / t.fill : null;
  const ref = t.status === 'CONDITIONAL' ? t.trigger : t.fill;
  t.distAtr = t.status === 'IN_ZONE' ? 0 : Math.abs(ref - c) / a;
  t.expiresBars = cfg.pendingBars;

  // gate
  const fails = [];
  if (!t.cleanStop) fails.push(`no clean invalidation after ${t.hops} stop hops`);
  if (t.stopAtr > cfg.stopMaxAtr + EPS) fails.push(`stop ${t.stopAtr.toFixed(2)} ATR exceeds ${cfg.stopMaxAtr} ATR`);
  if (!isNum(t.tp1)) fails.push(`no eligible target at least ${cfg.tpMinDistAtr} ATR away`);
  else if (t.rr1Net < cfg.minRR1 - EPS) fails.push(`R:R to TP1 ${t.rr1Net.toFixed(2)} below ${cfg.minRR1}`);
  t.passed = fails.length === 0;
  t.fails = fails;
  t.score = t.passed ? t.rr1Net * Math.exp(-t.distAtr / cfg.fillDecayAtr) : null;
  return t;
}

function retestTrade(z, snap, zones, dir, cfg) {
  const a = snap.atr;
  const c = snap.price;
  const hw = cfg.entryHalfWidthAtr * a;
  const entry = { low: z.pivot - hw, high: z.pivot + hw };
  const inZone = dir < 0 ? c >= entry.low - EPS : c <= entry.high + EPS;
  const fill = inZone ? c : z.pivot;
  const start =
    dir < 0
      ? Math.max(z.high + cfg.stopZoneBufferAtr * a, fill + cfg.stopMinAtr * a)
      : Math.min(z.low - cfg.stopZoneBufferAtr * a, fill - cfg.stopMinAtr * a);
  const s = resolveStop(start, z, zones, dir, a, cfg);
  const t = {
    type: 'RETEST',
    side: dir < 0 ? 'SHORT' : 'LONG',
    status: inZone ? 'IN_ZONE' : 'PENDING',
    zone: z,
    zoneId: z.id,
    entryLow: entry.low,
    entryHigh: entry.high,
    fill,
    trigger: null,
    stop: s.stop,
    hops: s.hops,
    cleanStop: s.clean,
    invalidation: `${dir < 0 ? 'close above' : 'close below'} the stop`,
  };
  return finishTrade(t, snap, zones, dir, cfg);
}

function continuationTrade(z, snap, zones, dir, cfg) {
  const a = snap.atr;
  const edge = dir < 0 ? z.low : z.high;
  const trigger = edge + dir * cfg.breakTriggerAtr * a;
  const fill = edge + dir * cfg.breakFillAtr * a;
  const start =
    dir < 0
      ? Math.max(z.high + cfg.stopHopBufferAtr * a, fill + cfg.stopMinAtr * a)
      : Math.min(z.low - cfg.stopHopBufferAtr * a, fill - cfg.stopMinAtr * a);
  // the stop sits back across the broken zone, on the same side as a retest stop
  const s = resolveStop(start, z, zones, dir, a, cfg);
  const t = {
    type: 'CONTINUATION',
    side: dir < 0 ? 'SHORT' : 'LONG',
    status: 'CONDITIONAL',
    zone: z,
    zoneId: z.id,
    entryLow: Math.min(trigger, fill),
    entryHigh: Math.max(trigger, fill),
    fill,
    trigger,
    stop: s.stop,
    hops: s.hops,
    cleanStop: s.clean,
    invalidation: `${dir < 0 ? 'close back above' : 'close back below'} the broken zone`,
  };
  return finishTrade(t, snap, zones, dir, cfg);
}

// ============================================================================
// 5. Sizing (perpetuals, isolated margin)
// ============================================================================

export function sizing(t, snap, account, cfg = DEFAULTS) {
  const dir = t.side === 'SHORT' ? -1 : 1;
  const equity = account.equity;
  const riskPct = account.riskPct ?? cfg.riskPct;
  const mmr = account.mmr ?? cfg.mmr;
  const perUnit = Math.abs(t.stop - t.fill) + cfg.feeRate * (t.fill + t.stop);
  const riskUsd = equity * riskPct;
  const qty = riskUsd / perUnit;
  const notional = qty * t.fill;
  const buf = cfg.liqBufferAtr * snap.atr;
  const maxLev = dir < 0 ? 1 / ((t.stop + buf) / t.fill - 1 + mmr) : 1 / (1 + mmr - (t.stop - buf) / t.fill);
  const maxSafeLeverage = Math.max(1, Math.floor(maxLev));
  const leverage = account.leverage ?? maxSafeLeverage;
  const margin = notional / leverage;
  const liquidation = dir < 0 ? t.fill * (1 + 1 / leverage - mmr) : t.fill * (1 - 1 / leverage + mmr);
  const liqClearOfStop = dir < 0 ? liquidation >= t.stop + buf - EPS : liquidation <= t.stop - buf + EPS;
  return {
    equity, riskPct, riskUsd, qty, notional, maxSafeLeverage, leverage, margin, liquidation,
    liqClearOfStop, marginExceedsEquity: margin > equity,
  };
}

// ============================================================================
// 6. Decision
// ============================================================================

export function evaluate(snap, opts = {}) {
  const cfg = { ...DEFAULTS, ...(opts.config || {}) };
  if (!isNum(snap.price) || snap.price <= 0) throw new Error('snapshot.price must be a positive number');
  if (!isNum(snap.atr) || snap.atr <= 0) throw new Error('snapshot.atr must be a positive number');

  const dyn = [];
  const addDyn = (price, kind, label) => {
    if (isNum(price)) dyn.push({ price, kind, label, weight: cfg.dynamicWeight });
  };
  addDyn(snap.ma?.[10], 'ma10', 'MA10');
  addDyn(snap.ma?.[20], 'ma20', 'MA20 / BOLL mid');
  addDyn(snap.ma?.[120], 'ma120', 'MA120');
  addDyn(snap.boll?.upper, 'bollUpper', 'BOLL upper');
  addDyn(snap.boll?.lower, 'bollLower', 'BOLL lower');
  const stat = (snap.levels || []).map((l) => ({
    price: l.price,
    kind: l.kind || 'level',
    label: l.label || l.kind || 'level',
    weight: isNum(l.weight) ? l.weight : cfg.swingWeight,
  }));
  const zones = buildZones([...stat, ...dyn], snap.atr, cfg);
  const reg = regime(snap, cfg);

  const res = {
    version: VERSION,
    symbol: snap.symbol ?? null,
    timeframe: snap.timeframe ?? null,
    asOf: snap.asOf ?? null,
    price: snap.price,
    atr: snap.atr,
    atrPct: snap.atr / snap.price,
    regime: reg,
    stretch: null,
    zones,
    decision: 'NO_TRADE',
    reason: '',
    primary: null,
    alternate: null,
    candidates: [],
    rejected: [],
    sizing: null,
    dataNotes: [],
    display: null,
  };

  if (reg.components.maStack === null) res.dataNotes.push('no moving averages supplied');
  if (reg.components.swingSeq === null) res.dataNotes.push('swing sequence unknown (counted as 0)');
  if (reg.components.macdSide === null) res.dataNotes.push('MACD unknown (counted as 0)');
  if (!snap.levels?.length) res.dataNotes.push('no structural levels supplied; zones are built from moving levels only');

  if (reg.label === 'RANGE') {
    res.reason = `trend score ${reg.score.toFixed(2)} is inside +/-${cfg.trendThreshold}: no trend, no trade (range mode is not in v1)`;
    res.display = buildDisplay(res, snap, cfg);
    return res;
  }

  const dir = reg.label === 'UP' ? 1 : -1;
  const st = stretch(snap, dir, cfg);
  res.stretch = st;
  if (st.missing.length) res.dataNotes.push(`stretch inputs missing: ${st.missing.join(', ')}`);

  const c = snap.price;
  // retests: nearest eligible zones on the counter-trend side
  const retestZones = zones
    .filter((z) => z.eligible && (dir < 0 ? z.pivot > c : z.pivot < c))
    .sort((x, y) => (dir < 0 ? x.pivot - y.pivot : y.pivot - x.pivot))
    .slice(0, cfg.maxRetestZones);
  for (const z of retestZones) res.candidates.push(retestTrade(z, snap, zones, dir, cfg));

  // continuation: nearest eligible zone on the trend side, only if not stretched
  const contZone = zones
    .filter((z) => z.eligible && (dir < 0 ? z.high < c : z.low > c))
    .sort((x, y) => (dir < 0 ? y.high - x.high : x.low - y.low))[0];
  if (contZone) {
    if (st.score < cfg.stretchMaxForContinuation) {
      res.candidates.push(continuationTrade(contZone, snap, zones, dir, cfg));
    } else {
      res.rejected.push({
        type: 'CONTINUATION',
        zoneId: contZone.id,
        reason: `stretch ${st.score.toFixed(2)} is at or above ${cfg.stretchMaxForContinuation}: a ${dir < 0 ? 'breakdown' : 'breakout'} entry here would be chasing`,
      });
    }
  }

  for (const t of res.candidates) {
    if (!t.passed) res.rejected.push({ type: t.type, zoneId: t.zoneId, reason: t.fails.join('; ') });
  }
  const passing = res.candidates.filter((t) => t.passed).sort((x, y) => y.score - x.score);
  if (!passing.length) {
    res.reason = 'no candidate passed the gate';
    res.display = buildDisplay(res, snap, cfg);
    return res;
  }
  res.primary = passing[0];
  res.alternate = passing[1] ?? null;
  res.decision = res.primary.side;
  res.reason = `${res.primary.type.toLowerCase()} ${res.primary.side.toLowerCase()} at ${res.primary.zoneId} has the best R:R after the distance penalty`;
  if (opts.account && isNum(opts.account.equity)) res.sizing = sizing(res.primary, snap, opts.account, cfg);
  res.display = buildDisplay(res, snap, cfg);
  return res;
}

// ============================================================================
// 7. Full pipeline from candles
// ============================================================================

// candles: [{ t, o, h, l, c, v }], oldest first, closed bars only.
export function analyze(candles, opts = {}) {
  const cfg = { ...DEFAULTS, ...(opts.config || {}) };
  if (!Array.isArray(candles) || candles.length < cfg.minBars) {
    throw new Error(`analyze() needs at least ${cfg.minBars} closed candles`);
  }
  const h = candles.map((k) => k.h);
  const l = candles.map((k) => k.l);
  const c = candles.map((k) => k.c);
  const ind = computeIndicators(h, l, c, cfg);
  const last = c.length - 1;
  const swings = filterSwings(fractals(h, l, cfg.fractalSide, last), ind.atr, cfg.swingMinAtr);
  const snap = {
    symbol: opts.symbol,
    timeframe: opts.timeframe,
    asOf: candles[last].t,
    tickSize: opts.tickSize,
    price: c[last],
    atr: ind.atr[last],
    ma: Object.fromEntries(cfg.maPeriods.map((p) => [p, ind.ma[p][last]])),
    boll: { upper: ind.boll.upper[last], mid: ind.boll.mid[last], lower: ind.boll.lower[last] },
    macd: { dif: ind.macd.dif[last], dea: ind.macd.dea[last], hist: ind.macd.hist[last] },
    rsi: Object.fromEntries(cfg.rsiPeriods.map((p) => [p, ind.rsi[p][last]])),
    kdj: { k: ind.kdj.k[last], d: ind.kdj.d[last], j: ind.kdj.j[last] },
    swingSeq: swingSequence(swings),
    levels: swings.map((s) => ({
      price: s.price,
      kind: s.type === 'H' ? 'swingHigh' : 'swingLow',
      label: `${s.type === 'H' ? 'swing high' : 'swing low'} (bar ${s.i})`,
    })),
    ctx: opts.ctx || {},
  };
  const out = evaluate(snap, { config: cfg, account: opts.account });
  out.snapshot = snap;
  return out;
}

// ============================================================================
// 8. Display strings and the narrative number check
// ============================================================================

export function priceDecimals(price, tickSize) {
  if (isNum(tickSize) && tickSize > 0) return Math.max(0, Math.round(-Math.log10(tickSize)));
  return Math.min(8, Math.max(0, 4 - Math.floor(Math.log10(Math.abs(price)))));
}

function buildDisplay(res, snap, cfg) {
  const dec = priceDecimals(snap.price, snap.tickSize);
  const P = (v) => (isNum(v) ? v.toFixed(dec) : 'n/a');
  const R = (v) => (isNum(v) ? v.toFixed(2) : 'n/a');
  const PCT = (v) => (isNum(v) ? `${(v * 100).toFixed(2)}%` : 'n/a');
  const trade = (t) =>
    t && {
      type: t.type, side: t.side, status: t.status, zone: t.zoneId,
      entryLow: P(t.entryLow), entryHigh: P(t.entryHigh), entry: P(t.fill),
      trigger: t.trigger === null ? 'n/a' : P(t.trigger),
      stop: P(t.stop), stopAtr: R(t.stopAtr), stopPct: PCT(t.stopPct),
      tp1: P(t.tp1), tp1Pct: PCT(t.tp1Pct), rr1: R(t.rr1), rr1Net: R(t.rr1Net),
      tp2: P(t.tp2), tp2Pct: PCT(t.tp2Pct), rr2: R(t.rr2), rr2Net: R(t.rr2Net),
      distAtr: R(t.distAtr), expiresBars: String(t.expiresBars), invalidation: t.invalidation,
    };
  const sz = res.sizing;
  return {
    header: [snap.symbol, snap.timeframe].filter(Boolean).join(' '),
    asOf: snap.asOf == null ? 'n/a' : String(snap.asOf),
    decision: res.decision,
    reason: res.reason,
    price: P(snap.price),
    atr: P(snap.atr),
    atrPct: PCT(snap.atr / snap.price),
    regime: { label: res.regime.label, score: R(res.regime.score) },
    stretch: res.stretch && {
      score: R(res.stretch.score),
      coverage: PCT(res.stretch.coverage),
      top: res.stretch.top.join(', '),
      components: Object.fromEntries(Object.entries(res.stretch.components).map(([k, v]) => [k, R(v)])),
    },
    zones: res.zones.map((z) => ({
      id: z.id, low: P(z.low), high: P(z.high), pivot: P(z.pivot),
      strength: z.strength.toFixed(1), eligible: z.eligible ? 'yes' : 'no',
      members: z.members.map((m) => `${m.label} ${P(m.price)}`).join('; '),
    })),
    primary: trade(res.primary),
    alternate: trade(res.alternate),
    candidates: res.candidates.map(trade),
    rejected: res.rejected.map((r) => `${r.type} ${r.zoneId}: ${r.reason}`),
    sizing: sz && {
      equity: sz.equity.toFixed(2), riskPct: PCT(sz.riskPct), riskUsd: sz.riskUsd.toFixed(2),
      qty: sz.qty.toFixed(4), notional: sz.notional.toFixed(2),
      maxSafeLeverage: `${sz.maxSafeLeverage}x`, leverage: `${sz.leverage}x`,
      margin: sz.margin.toFixed(2), liquidation: P(sz.liquidation),
      liqClearOfStop: sz.liqClearOfStop ? 'yes' : 'no',
    },
    dataNotes: res.dataNotes.join('; '),
  };
}

const NUM_RE = /[-+−]?\d[\d,]*(?:\.\d+)?/g;
const norm = (s) => s.replace(/[,]/g, '').replace(/^[-+−]/, '');

// Returns every number in `text` that does not appear in result.display.
// Small integers (0-10) are allowed so labels like "TP1" or "4h" pass.
export function validateNarrative(text, result) {
  const allowed = new Set();
  const walk = (o) => {
    if (o == null) return;
    if (typeof o === 'string') {
      for (const m of o.match(NUM_RE) || []) allowed.add(norm(m));
    } else if (typeof o === 'object') {
      Object.values(o).forEach(walk);
    }
  };
  walk(result.display);
  const unknown = [];
  for (const m of String(text).match(NUM_RE) || []) {
    const n = norm(m);
    if (/^\d+$/.test(n) && Number(n) <= 10) continue;
    if (!allowed.has(n)) unknown.push(m);
  }
  return { ok: unknown.length === 0, unknown: [...new Set(unknown)] };
}
