// test/backtest-signals.mjs — reproducible signal backtest with REAL execution costs.
//
// PURPOSE (validation, not advice): does the signal layer's alpha survive real fees +
// slippage, and does it survive a BULL regime — or is it an artefact of costless,
// bear-only testing? Output is a table of gross → net numbers + a bull-vs-hold gap.
//
// This is an OFFLINE script (node, not a Vercel function). It is READ-ONLY against the
// signal layer: it imports the existing pure functions from lib/ and NEVER changes the
// logic, thresholds, or sizing. Deterministic — no RNG, same inputs → same numbers.
//
//   Run:  node test/backtest-signals.mjs [path-to-btc_daily.json]
//   Data: JSON array of [ "YYYY-MM-DD", close ] pairs, ascending by date.
//         (exported from Supabase public.btc_history — daily BTC closes ≥2011)
//
// Indicators are reconstructed per-day from the SAME functions the app persists with
// (lib/scoring.js: rsiSeries / stochRsiSeries / macdSeries / scoreBelowHigh) and the
// phase from lib/cycle.js (classifySeries). score_fundamentals / score_activity are
// token-specific and DO NOT exist historically for BTC → left null (honest). They only
// nudge confidence grading, never whether a trade fires, so trade timing is unaffected.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { rsiSeries, stochRsiSeries, macdSeries, scoreBelowHigh, highLow } from '../lib/scoring.js';
import { classifySeries } from '../lib/cycle.js';
import { generateSignals } from '../lib/signals.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = process.argv[2] || resolve(__dir, '../../btc_daily.json');

// ── cost model (state every assumption) ─────────────────────────────────────────
// Per-fill cost = taker fee + slippage, charged on BOTH sides (buy and sell) and on the
// terminal liquidation. Two fee tiers tested. Slippage flat on liquid BTC (our unit is
// tiny relative to BTC liquidity, so a few bps is defensible; larger fills would cost
// more — noted in the report). All fractions of notional.
const COST_TIERS = [
  { name: 'gross (no costs)', fee: 0.0,     slip: 0.0    },
  { name: 'net · low fee',    fee: 0.0005,  slip: 0.0005 },   // 5 bps fee + 5 bps slip / side
  { name: 'net · high fee',   fee: 0.0010,  slip: 0.0005 },   // 10 bps fee + 5 bps slip / side
];

const UNIT = 100;   // $ deployed on a 1.0× BUY. Alpha scales linearly with UNIT; we also
                    // report unit-independent return %. Absolute $ depends on this choice.

// ── load data ───────────────────────────────────────────────────────────────────
const raw = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
const dates  = raw.map((r) => r[0]);
const closes = raw.map((r) => Number(r[1]));
const N = closes.length;

// ── reconstruct per-day readings from closes (same math the app persists) ─────────
const rsiArr   = rsiSeries(closes, 14);
const stochArr = stochRsiSeries(closes, 14, 14);
const macd     = macdSeries(closes, 12, 26, 9);
const cls      = classifySeries(closes);            // phase per index (long-cycle detector)

const readings = new Array(N);
const phaseByDate = {};
for (let i = 0; i < N; i++) {
  const high365 = highLow(closes, 365, i).high;
  readings[i] = {
    fetched_at: dates[i] + 'T00:00:00Z',
    price: closes[i],
    rsi_14: rsiArr[i],
    stochrsi_14: stochArr[i],
    macd_histogram: macd.hist[i],
    score_below_high: scoreBelowHigh(closes[i], high365),
    score_fundamentals: null,   // not stored historically for BTC — honest null
    score_activity: null,       // not stored historically for BTC — honest null
    structural_decline: false,  // BTC is not a survivorship-flagged token
  };
  phaseByDate[dates[i]] = cls[i].phase;
}

// ── portfolio simulator (respects the EXACT signal semantics) ─────────────────────
// BUY  → deploy UNIT × size_mult dollars of NEW capital into BTC (allocation multiplier).
// SELL → realize size_mult FRACTION of current BTC holdings (partial in euphoria).
// Costs hit every fill. Equity = cash + btc·price, marked daily for drawdown/time-in-mkt.
// Alpha benchmark = the SAME dollars deployed on the SAME days but NEVER sold, held to end
// (DCA-matched buy-&-hold) → isolates the effect of the strategy's selling/sitting-out.
// We also report a classic LUMP buy-&-hold (all deployed capital in at window start).
function simulate(idxFrom, idxTo, cost) {
  const sub = readings.slice(idxFrom, idxTo + 1);
  const sigs = generateSignals(sub, phaseByDate);   // <-- unchanged signal logic
  const sigByDay = new Map();
  for (const s of sigs) sigByDay.set(String(s.signal_date).slice(0, 10), s);

  // Prefund all three books with the SAME budget = the strategy's total BUY dollars, so
  // their equity curves and returns are directly comparable (equal capital at risk).
  let budget = 0;
  for (const s of sigs) if (s.side === 'BUY') budget += UNIT * s.size_mult;
  if (budget <= 0) budget = UNIT;   // no buys in window → nominal, avoids /0

  const startPx = sub[0].price;
  const lumpBtc = budget / (startPx * (1 + cost.fee + cost.slip));   // LUMP B&H: all in at start

  let cash = budget, btc = 0, deployed = 0;   // strategy account (cash held earns nothing)
  let dcaCash = budget, dcaBtc = 0;           // DCA-matched hold: same buys, NEVER sells
  let nBuy = 0, nSell = 0, daysInMkt = 0;
  let peak = -Infinity, maxDD = 0;            // drawdown on strategy account value
  let hpeak = -Infinity, hmaxDD = 0;          // drawdown on LUMP buy-&-hold

  for (let k = 0; k < sub.length; k++) {
    const day = String(sub[k].fetched_at).slice(0, 10);
    const px  = sub[k].price;
    const sig = sigByDay.get(day);
    if (sig) {
      if (sig.side === 'BUY') {
        const dollars = UNIT * sig.size_mult;
        const eff = px * (1 + cost.fee + cost.slip);      // pay up on buys
        btc  += dollars / eff;  cash    -= dollars; deployed += dollars;
        dcaBtc += dollars / eff; dcaCash -= dollars;       // benchmark buys identically
        nBuy++;
      } else { // SELL — realize a fraction of holdings
        const sellBtc = btc * sig.size_mult;
        const eff = px * (1 - cost.fee - cost.slip);       // receive less on sells
        cash += sellBtc * eff;  btc -= sellBtc;
        nSell++;
      }
    }
    if (btc > 1e-12) daysInMkt++;
    const eq = cash + btc * px;               // strategy account value
    if (eq > peak) peak = eq; if (peak > 0) { const dd = (peak - eq) / peak; if (dd > maxDD) maxDD = dd; }
    const heq = lumpBtc * px;                 // lump B&H account value
    if (heq > hpeak) hpeak = heq; if (hpeak > 0) { const dd = (hpeak - heq) / hpeak; if (dd > hmaxDD) hmaxDD = dd; }
  }

  // terminal liquidation at the last close (costs applied for net runs)
  const liqEff = sub[sub.length - 1].price * (1 - cost.fee - cost.slip);
  const stratEnd = cash + btc * liqEff;                  // final account value
  const holdEnd  = dcaCash + dcaBtc * liqEff;            // DCA-matched, never sold
  const lumpEnd  = lumpBtc * liqEff;                     // lump, all-in at start

  const ret = (end) => ((end - budget) / budget) * 100;
  return {
    nBuy, nSell, budget, deployed,
    stratEnd, stratPnl: stratEnd - budget, stratRet: ret(stratEnd),
    holdPnl: holdEnd - budget, holdRet: ret(holdEnd),
    lumpPnl: lumpEnd - budget, lumpRet: ret(lumpEnd),
    alphaVsHold$: stratEnd - holdEnd, alphaVsHoldPP: ret(stratEnd) - ret(holdEnd),
    alphaVsLump$: stratEnd - lumpEnd, alphaVsLumpPP: ret(stratEnd) - ret(lumpEnd),
    maxDD: maxDD * 100, holdMaxDD: hmaxDD * 100,
    timeInMkt: (daysInMkt / sub.length) * 100,
    signals: sigs,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
const idxOf = (dateStr, dir) => {   // nearest index with date >= (dir=1) or <= (dir=-1)
  if (dir === 1) { for (let i = 0; i < N; i++) if (dates[i] >= dateStr) return i; return N - 1; }
  for (let i = N - 1; i >= 0; i--) if (dates[i] <= dateStr) return i; return 0;
};
const money = (x) => (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(2);
const pp = (x) => (x >= 0 ? '+' : '') + x.toFixed(1) + '%';

// ── 1) FULL HISTORY — gross → net erosion ─────────────────────────────────────────
const out = { generatedFromRows: N, span: [dates[0], dates[N - 1]], unit: UNIT, full: [], bull: [], bear: [] };
console.log('════════════════════════════════════════════════════════════════════');
console.log('WAKAWAKA signal backtest — BTC daily', dates[0], '→', dates[N - 1], `(${N} days)`);
console.log('UNIT per 1.0x BUY = $' + UNIT, '· costs charged both sides + on liquidation');
console.log('════════════════════════════════════════════════════════════════════');
console.log('\n### 1. FULL HISTORY — real-cost erosion (strategy vs DCA-matched hold)\n');
console.log('cost tier          | trades  | strat P&L | strat ret | hold ret | alpha vs hold | maxDD | in-mkt');
console.log('-------------------|---------|-----------|-----------|----------|---------------|-------|-------');
for (const cost of COST_TIERS) {
  const r = simulate(0, N - 1, cost);
  out.full.push({ tier: cost.name, ...stripSignals(r) });
  console.log(
    cost.name.padEnd(18), '|',
    String(`${r.nBuy}B/${r.nSell}S`).padStart(7), '|',
    money(r.stratPnl).padStart(9), '|',
    pp(r.stratRet).padStart(9), '|',
    pp(r.holdRet).padStart(8), '|',
    (pp(r.alphaVsHoldPP) + ' / ' + money(r.alphaVsHold$)).padStart(13), '|',
    (r.maxDD.toFixed(0) + '%').padStart(5), '|',
    (r.timeInMkt.toFixed(0) + '%').padStart(5));
}

// ── 2) BULL REGIMES — strategy net vs buy-and-hold ────────────────────────────────
const BULLS = [
  { name: '2015–2017 bull', from: '2015-01-01', to: '2017-12-31' },
  { name: '2019–2021 bull', from: '2019-01-01', to: '2021-11-30' },
  { name: '2023–2024 bull', from: '2023-01-01', to: '2024-03-31' },
];
console.log('\n### 2. BULL REGIMES — net (low fee) strategy vs buy-and-hold\n');
console.log('window          | trades  | strat ret | LUMP B&H | DCA B&H | gap vs LUMP | maxDD | in-mkt');
console.log('----------------|---------|-----------|----------|---------|-------------|-------|-------');
const NET_LOW = COST_TIERS[1];
for (const b of BULLS) {
  const a = idxOf(b.from, 1), z = idxOf(b.to, -1);
  const r = simulate(a, z, NET_LOW);
  out.bull.push({ window: b.name, from: dates[a], to: dates[z], ...stripSignals(r) });
  console.log(
    b.name.padEnd(15), '|',
    String(`${r.nBuy}B/${r.nSell}S`).padStart(7), '|',
    pp(r.stratRet).padStart(9), '|',
    pp(r.lumpRet).padStart(8), '|',
    pp(r.holdRet).padStart(7), '|',
    (pp(r.alphaVsLumpPP)).padStart(11), '|',
    (r.maxDD.toFixed(0) + '%').padStart(5), '|',
    (r.timeInMkt.toFixed(0) + '%').padStart(5));
}

// ── 3) BEAR REGIMES — does it protect? (the prior "positive alpha in bear" claim) ─
const BEARS = [
  { name: '2014–2015 bear', from: '2014-01-01', to: '2015-08-31' },
  { name: '2018 bear',      from: '2018-01-01', to: '2018-12-31' },
  { name: '2022 bear',      from: '2021-12-01', to: '2022-12-31' },
];
console.log('\n### 3. BEAR REGIMES — net (low fee) strategy vs buy-and-hold (risk-reducer test)\n');
console.log('window          | trades  | strat ret | LUMP B&H | strat maxDD | hold maxDD | in-mkt | alpha vs LUMP');
console.log('----------------|---------|-----------|----------|-------------|------------|--------|--------------');
for (const b of BEARS) {
  const a = idxOf(b.from, 1), z = idxOf(b.to, -1);
  const r = simulate(a, z, NET_LOW);
  out.bear.push({ window: b.name, from: dates[a], to: dates[z], ...stripSignals(r) });
  console.log(
    b.name.padEnd(15), '|',
    String(`${r.nBuy}B/${r.nSell}S`).padStart(7), '|',
    pp(r.stratRet).padStart(9), '|',
    pp(r.lumpRet).padStart(8), '|',
    (r.maxDD.toFixed(0) + '%').padStart(11), '|',
    (r.holdMaxDD.toFixed(0) + '%').padStart(10), '|',
    (r.timeInMkt.toFixed(0) + '%').padStart(6), '|',
    (pp(r.alphaVsLumpPP)).padStart(12));
}

// full-history buy/sell ledger (for the report appendix) at net-low
const ledger = simulate(0, N - 1, NET_LOW).signals.map((s) => ({
  date: String(s.signal_date).slice(0, 10), side: s.side, price: s.price_at_signal,
  rsi: s.rsi_at_signal, phase: s.cycle_phase, size_mult: s.size_mult,
  confidence: s.confidence, confirmers: s.confirmers,
}));
out.ledger = ledger;
console.log('\n### signal ledger:', ledger.length, 'emitted signals (full history, see JSON)');

function stripSignals(r) { const { signals, ...rest } = r; return rest; }

// emit machine-readable results next to the data file
const OUT_PATH = resolve(dirname(DATA_PATH), 'backtest_results.json');
import('node:fs').then((fs) => {
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log('\nwrote', OUT_PATH);
});
