# WAKAWAKA — Signal Validation: real execution costs + bull-regime test

**Question:** does the signal layer's alpha survive real fees + slippage, and does it
survive a bull market — or is it an artefact of costless, bear-only testing?

**Short answer:** The costs are a non-issue — turnover is so low (~2.4 signals/year) that
5–10 bps per side barely scratches the result. But the "alpha" is **not** alpha in the
sense of beating buy-and-hold. **This is a risk-reducer, not an alpha-generator.** It
loses badly to holding BTC across a bull/secular uptrend, and its real value shows up in
**bear markets**, where it cuts losses and drawdown by roughly two-thirds. The prior
"positive alpha in bear periods, contrarian/mean-reversion" characterisation is
**confirmed**; the "+$110" figure could not be reproduced exactly (no original harness in
the repo — see §6) and the absolute dollar number is model/unit dependent.

> Research / validation only. **Not investment advice.** No strategy tuning was done — the
> goal was truth, including "it does not beat holding."

---

## 1. How it was tested (reproducible, read-only, deterministic)

- **Harness:** `test/backtest-signals.mjs` — an **offline Node script** (NOT a Vercel
  function; Hobby is at the 12-function cap). Run:
  `node test/backtest-signals.mjs <btc_daily.json>`.
- **Signal logic is UNCHANGED.** The harness imports and calls the existing pure functions
  — `generateSignals` / `phaseSizeMult` from `lib/signals.js`, indicator math from
  `lib/scoring.js`, phase from `lib/cycle.js`. Those three files are byte-identical to the
  committed HEAD. Nothing about thresholds (RSI_BUY 22 / RSI_SELL 78), the 30-day cooldown,
  the phase gates, the no-orphan-sell state machine, or the sizing was touched.
- **Data:** real BTC daily closes from Supabase `public.btc_history` — **5,432 days,
  2011-08-18 → 2026-07-01**, verified strictly ascending, no duplicates, no gaps.
- **Indicators reconstructed per-day** from those closes with the *same* functions the app
  persists with (`rsiSeries`, `stochRsiSeries`, `macdSeries`, `scoreBelowHigh`) and the
  phase from `classifySeries`. Deterministic — no RNG, same input → same output every run.
- **Data-availability caveat (honest):** `score_fundamentals` and `score_activity` are
  token-specific and **do not exist historically for BTC**, so they are left `null`. They
  only *nudge confidence grading*; they never decide whether a trade fires. So **trade
  timing is unaffected** — only the confidence number on each signal is graded on fewer
  confirmers (RSI + StochRSI + MACD + below-high). This leg is honestly not-testable for BTC.

### Cost model (every assumption stated)
- Charged on **both** sides (buy and sell) and on the terminal liquidation.
- **Fees:** low = **5 bps/side** (0.05%), high = **10 bps/side** (0.10%) — defensible taker
  fees for a liquid CEX.
- **Slippage:** flat **5 bps/side** on liquid BTC. Our fill size ($100 × phase multiplier)
  is tiny relative to BTC liquidity, so a few bps is realistic; a large fill relative to the
  allocation would cost more — noted, not modelled, because the unit is small.
- **Unit:** $100 deployed per 1.0× BUY (1.5× in accumulation). Absolute $ scales linearly
  with the unit; we therefore also report unit-independent **return %**.

### Benchmarks (equal capital, so comparisons are fair)
All books are prefunded with the **same budget** = the strategy's total BUY dollars.
- **Strategy** — the signal state machine, phase-sized, with costs.
- **LUMP buy-&-hold** — the whole budget invested at the window's first close, held to the end.
- **DCA-matched hold** — the *same* buys on the *same* days, but **never sold** (isolates the
  effect of the strategy's selling/sitting-out).

---

## 2. Result #1 — real-cost erosion (FULL history 2011→2026)

24 BUYs / 12 SELLs over ~15 years.

| cost tier          | trades  | strategy return | strat maxDD | hold maxDD | time-in-market |
|--------------------|---------|-----------------|-------------|------------|----------------|
| gross (no costs)   | 24B/12S | **+47.3%**      | 8%          | 85%        | 36%            |
| net · low fee (5bps)| 24B/12S| **+47.0%**      | 8%          | 85%        | 36%            |
| net · high fee (10bps)|24B/12S| **+46.9%**     | 8%          | 85%        | 36%            |

**Costs survive, trivially.** Gross +47.3% → net(high) +46.9%: **~0.4 percentage points of
erosion across 36 fills** (≈ $14.6 on the $100 unit). ~5 signals/yr — actually ~2.4/yr here
— is such low turnover that fees + slippage are noise. **This half of the thesis holds.**

But look at the benchmark on the same capital and window: **DCA-matched hold returned
+90,635%** and lump buy-&-hold **+535,988%** (BTC went from ~$10 to ~$58k). So over the full
history the strategy is *not* an alpha generator vs holding — it captures a tiny fraction of
BTC's secular rise because it repeatedly sells into strength and sits in cash 64% of the time.
Its one structural win here is **drawdown: 8% vs the hold's 85%.**

---

## 3. Result #2 — BULL regimes (net, low fee): strategy vs buy-and-hold

| window          | trades | strategy | LUMP B&H | DCA B&H | gap vs LUMP | strat maxDD | time-in-mkt |
|-----------------|--------|----------|----------|---------|-------------|-------------|-------------|
| 2015–2017 bull  | 5B/2S  | +81.8%   | +4,314%  | +5,775% | **−4,232 pp** | 24%       | 29%         |
| 2019–2021 bull  | 2B/1S  | +84.8%   | +1,387%  | +853%   | **−1,302 pp** | 31%       | 23%         |
| 2023–2024 bull  | 1B/1S  | +69.6%   | +328%    | +173%   | **−259 pp**   | 16%       | 38%         |

**In a bull market the strategy is crushed by buy-and-hold** — exactly what a
contrarian/mean-reversion system does. It sells into strength, then sits out (time-in-market
23–38%), so it captures a double-digit gain while holding captures hundreds-to-thousands of
percent. **The prior test was bear-weighted; in a bull the alpha does not just shrink, it
inverts.** The strategy is a poor way to be long BTC in an uptrend.

---

## 4. Result #3 — BEAR regimes (net, low fee): the risk-reducer test

The prior claim was "positive alpha in bear periods." Tested directly:

| window          | trades | strategy | LUMP B&H | strat maxDD | hold maxDD | alpha vs LUMP |
|-----------------|--------|----------|----------|-------------|------------|---------------|
| 2014–2015 bear  | 5B/0S  | **−10.6%** | −69.6% | 27%         | 81%        | **+59.0 pp**  |
| 2018 bear       | 6B/1S  | **−19.7%** | −72.6% | 33%         | 81%        | **+52.9 pp**  |
| 2022 bear       | 3B/0S  | **−13.3%** | −71.2% | 20%         | 72%        | **+57.9 pp**  |

**Confirmed.** In every bear the strategy loses far less than holding (−11 to −20% vs −70%),
with drawdowns roughly a third of the hold's. It doesn't make money in a bear — it **avoids
the worst of the loss** by staying mostly in cash and only nibbling deep RSI≤22 dips. This is
the system's genuine edge, and it is real net of costs.

---

## 5. Signal quality sanity-check (ledger)

36 emitted signals, and they fire where they should:
- **BUYs (24):** all at RSI 10–22, in `accumulation` (18) or `rise` (6). None in
  euphoria/correction — the phase gate works.
- **SELLs (12):** all at RSI 79–92, in `correction` (9) or `rise` (3). None in accumulation —
  gate works. No orphan sells (every SELL had an open position).
- Confluence grades look sane (deep-oversold accumulation buys grade 7; overbought
  correction sells grade 7–8).

Frequency is **~2.4 signals/yr (1.6 BUY/yr)** over 15 years — *lower* than the "~5/yr" the
brief cited. Not wrong, just worth flagging: on this dataset the trigger is rarer than
advertised (BTC rarely closes at RSI≤22 / ≥78 on the daily).

---

## 6. Honest verdict

- **Does net-of-cost alpha survive?**
  - **Costs: yes, comfortably.** ~2.4 signals/yr → ~0.4 pp erosion over 36 fills. Turnover is
    far too low for fees/slippage to matter. The "+alpha survives real costs" claim holds.
  - **Vs buy-and-hold: no, not as total return.** Over the full history and in every bull
    window the strategy underperforms holding BTC by a wide margin (it sells into strength and
    sits in cash). It is **not an alpha generator**.

- **In which regimes does it "work"?** **Bear markets only.** There it beats buy-and-hold by
  ~53–59 pp and cuts drawdown from ~70–85% to ~20–33%. It still *loses* in a bear — it just
  loses much less.

- **Risk-reducer or alpha-generator?** **Unambiguously a risk-reducer.** Its entire value is
  drawdown avoidance and bear-market loss mitigation — not compounding. Full-history maxDD 8%
  vs 85% is the headline. If you hold it expecting it to beat BTC, it will disappoint in every
  bull; if you hold it to sleep through bears with a fraction of the drawdown, it delivers.

- **The prior "+$110 / contrarian / bear-alpha" report:** direction **confirmed** (contrarian
  is exactly what the ledger shows; bear alpha is real). The **exact +$110 could not be
  reproduced** — there is no original backtest harness in the repo to match, and the absolute
  figure depends on the unit and accounting. At $100/BUY this harness shows **+$1,562 gross
  full-history P&L**; that number is model-dependent and should be read as "positive gross,"
  not as a target. The return-% and regime results above are the trustworthy findings.

---

## 7. Reproduce it

```
# 1. export the daily series (5,432 rows) from Supabase public.btc_history → btc_daily.json
#    format: [["YYYY-MM-DD", close], ...] ascending
# 2. run:
node test/backtest-signals.mjs /path/to/btc_daily.json
```
Deterministic — same inputs produce the tables above every run. Machine-readable numbers
(every tier + window + the full signal ledger) are written to `backtest_results.json`.

**Confirmations:** signal logic unchanged (lib/signals.js, lib/scoring.js, lib/cycle.js
identical to HEAD); no new serverless function; numbers are seeded/reproducible; every cost
and slippage assumption is stated above.
