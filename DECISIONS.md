# DECISIONS — assumptions made while building to the brief

Where the brief left room, I picked the simplest option that satisfies it and
noted it here.

## Scoring math (concrete formulas the brief specified qualitatively)
- **Price vs MAs:** each MA contributes a 0..1 proximity term
  `(clamp((price−MA)/MA, −1, 1)+1)/2`; averaged across the MAs that exist, ×10.
  At the MA → 5; ≥100% above both → 10; ≥100% below → 0. Averaging (not summing)
  means it degrades gracefully when MA200 isn't available yet (early backfill days).
- **TVL + holders-revenue:** average of (a) 30d TVL trend mapped −50%→0 / flat→5 /
  +50%→10, and (b) market-cap ÷ annual-holders-revenue multiple mapped
  0→10 / 100×→0. Uses market cap (price × circulating supply) as the "price" side
  of the multiple.
- **Emissions rate** = `(total_supply − circ_supply) / circ_supply` as a dilution
  proxy (the brief's fallback; no clean vesting/annualization figure is available
  on the free tiers). Mapped 0%→10, ≥30%→0.
- **RSI score** is the piecewise-linear curve through the brief's anchor points
  (0→10, 30→8, 50→5, 70→2, 100→0).

## Sources
- **CoinGecko free tier caps historical daily data at 365 days**, so backfill is
  365 days max (the brief's 12-month floor). MA200 therefore isn't available for
  the first ~200 backfilled days; the price-vs-MA sub-score uses MA50 alone there
  and fills in once 200 days of history exist. Scores are still produced from the
  available sub-scores — no gaps.
- **Holders revenue** is annualized from DefiLlama's `dailyHoldersRevenue` summary
  (`total30d/30×365`, falling back to `total24h×365`). If the endpoint returns
  nothing usable, that half of sub-score 4 is dropped and the TVL-trend half stands.
- **Backfill fundamentals:** per-day TVL is reconstructed from DefiLlama's TVL
  history (it's a real time series); holders-revenue and supply are held at the
  current value for historical days (history isn't cleanly available) and the row
  is still stamped `is_backfill = true`.

## Infra / conventions
- **No SDK dependency.** Serverless functions use native `fetch` against Supabase
  PostgREST with the service-role key. Frontend uses PostgREST with the anon key.
  Keeps it buildless and framework-free per the brief.
- **`public/config.js`** holds the frontend's Supabase URL + anon key (mirrors a
  common static-site pattern) rather than a build-time inject, since there's no
  build step. The service-role key never appears client-side.
- **RLS:** anon gets `select` on both tables, plus `insert` and `update(active)`
  on `tracked_tokens` only — needed for the dashboard's add/remove buttons.
  `score_readings` writes are service-role only.
- **`CRON_SECRET`** (optional) protects `/api/backfill` (and `/api/cron-fetch`)
  from public invocation. Vercel cron sends it automatically as a Bearer header.
- **Idempotency:** cron no-ops a token if a row already landed within the last ~2h.
- **Repo name** assumed `bestbuy` per the brief (confirm if you'd prefer another).

## UI
- Default range **30d**; range switches refilter already-loaded data client-side
  (no refetch); all readings plotted (no downsampling), smoothing via tension 0.4.
- Dual-tier month/year axis is drawn as a Chart.js plugin keyed off the x-scale
  pixel positions (year shown bold at January boundaries / first visible month).
- Per-metric delta "improved" direction: higher-is-better for the score-based and
  TVL/revenue rows; lower-is-better for RSI and emissions (oversold / low inflation
  are the favorable directions).

## Emissions axis — real annual inflation (Option B)
- The 5th axis originally fed a **supply overhang** `(total−circ)/circ` into a function
  that expects an **annual rate**, so every token with locked supply clamped to 0. Fixed
  per `EMISSIONS_METRIC_REPORT.md` Option B: derive a circulating-supply series from
  `market_cap ÷ price` (CoinGecko `market_chart` returns both), then
  `inflation = (circ_now − circ_1yr_ago) / circ_1yr_ago`. `scoreEmissions` is unchanged.
- Short windows (young tokens / early backfill days) annualize the partial-window change
  (`× 365/days`); net burns floor at 0 → score 10.
- **Sanity check:** XRP's circulating supply grows ~6–8%/yr as escrow releases, so it should
  now score moderate-to-high on emissions instead of the old 0. A high-emission incentive
  token (e.g. AERO, whose supply inflates fast) should score low. Confirm the four live
  values after running `/api/recompute-emissions` (they must differ across tokens, not all 0).
- History is realigned in place by `/api/recompute-emissions` (only `emissions_rate`,
  `score_emissions`, `final_score` change) so the progression chart has no step at the fix.

## Fundamentals coverage factor (fixes emissions-only domination)
- A market-only token (no DeFi TVL/revenue) had its Fundamentals pillar built from
  **emissions alone**, and `weightedBlend` renormalized that lone 40%-weight slot to
  full strength — so XRP's low inflation alone pushed Fundamentals to 8.3 and the
  token to #1 STRONG BUY above AERO/CRV, which have real revenue. Root cause: the
  pillar carried no confidence penalty for thin coverage.
- Fix, part 1 — coverage factor in `scoreFundamentals`: `coverage = nComponentsPresent
  / 2`; with one component the score is shrunk toward neutral 5.0,
  `adjusted = 5 + (raw − 5) × coverage`. Both present → unchanged.
- Fix, part 2 — emissions-only cap: when there is NO TVL/revenue at all, the pillar
  rests entirely on emissions. Low inflation is the absence of a weakness, not a
  demonstrated strength, so an emissions-only pillar earns **no credit above neutral**
  (`adjusted = min(adjusted, 5.0)`) and cannot out-rank tokens with real TVL/revenue.
  High inflation alone still penalizes (below-neutral passes through). TVL-only is
  unaffected — TVL is a real fundamental.
- Result: XRP Fundamentals 8.3 → **5.0** (flat — its inflation never crosses below
  the neutral band), final 7.0 → **5.2 NEUTRAL**, dropping below the revenue tokens
  CRV (6.0) and AERO (5.9). XRP's score now varies with Technicals (and future
  Activity), not an emissions-inflated Fundamentals. Pillar-level reweight unchanged.
- History recomputed in place from stored sub-scores (only `score_fundamentals` +
  `final_score` change) → no chart discontinuity.

## Third pillar: Sentiment → Activity (on-chain adoption)
- The stubbed Sentiment slot becomes **Activity** (`score_sentiment` renamed to
  `score_activity`; pillar weights F45/T35/**A20**). Activity measures real on-chain
  use: active addresses (40%), holder growth (35%), transfer flow (25%) — weights via
  `W_ACTIVITY`, missing components drop and renormalize.
- **Stock-vs-flow honesty:** the APIs give current state, so Activity is a FLOW
  derived from the delta between two **live** snapshots. There is NO honest backfill —
  `score_activity` and the raw counts are null for every backfilled day and until two
  live snapshots exist. Never fabricated; empty ≠ zero everywhere (UI + Excel).
- **Sources (keyless — no new secret):** EVM tokens (AERO/VIRTUAL on Base,
  CRV/ONDO on Ethereum) use Blockscout v2 `/tokens/{contract}/counters`
  (`token_holders_count`, `transfers_count`); active addresses isn't exposed
  per-token by Blockscout → left null (honest gap). XRP uses public XRPL network
  metrics (xrpscan) — **best-effort and unverified** (sandbox network policy blocked
  live endpoint testing); it degrades to null if the response shape differs.
- **chain ≠ token separation:** XRP's Activity is XRPL *chain* activity (accounts,
  transactions) — never the TVL/revenue of DeFi protocols built on the XRPL, which
  is not XRP's. XRP Fundamentals stays free of any XRPL-DeFi value.
- Activity scoring curves (holder-growth band, transfer turnover) are provisional and
  tunable once real live data accumulates; they affect nothing until then.

## Raw-data archive (foundation for later correlation analysis)
- `score_readings` is an append-only log that now stores, per reading, the RAW value
  behind every score (`dist_from_low_pct`, `active_addresses`, `holder_count`,
  `transfer_count`, alongside the existing `ma_50/200`, `rsi_14`, `tvl`,
  `holders_revenue`, `emissions_rate`, `circ_supply`), the time-aligned `price`, and a
  `source_tier` (`backfill`|`live`) provenance flag — so the full series (e.g.
  Activity-vs-Price) is analysable months from now. `tracked_tokens` carries
  `chain`/`chain_id`/`contract_address` for the on-chain fetch.

## Category-aware Fundamentals (valuation multiple) — supersedes the TVL-universal pillar
- **Problem:** the old pillar assumed TVL is every token's value metric, so a token that
  earns real revenue but holds ~0 TVL (VIRTUAL: TVL=$0, revenue=$3.86M) scored dead on
  Fundamentals even though it has a genuine economic-value signal. The TVL-based
  components (TVL-trend, MC/TVL) were structurally null for it.
- **Fix:** `tracked_tokens.category` selects the value metric per token, and every metric
  is normalized to the SAME 0–10 axis via a **valuation multiple** = `market_cap ÷ annual
  value`. Low multiple = cheap vs. what it generates = high score — comparable across a
  DEX, an AI agent, and an L1.
  - `defi` (AERO/CRV/CAKE/HYPE), `rwa` (ONDO): TVL **and** revenue (mean of both).
  - `yield` (CVX): revenue + TVL (same as defi; revenue-led in practice).
  - `ai-agent` (VIRTUAL), `infra` (LINK): **revenue only** — TVL ignored (it's ~0/irrelevant).
  - `l1` (ETH/SOL/AVAX): **chain fees** (annualized) as the native token's value; the
    chain's third-party DeFi TVL is NOT the token's, so it isn't attributed.
  - `payment` (XRP), `uncovered` (TRAC): **null** — no honest free source; the pillar
    reweight hands scoring to Technicals (+ Activity). XRP's real value (settlement
    volume) lives in the Activity pillar; TRAC's publishing fees have no free feed.
- **Valuation-multiple thresholds** (`scoreValuationMultiple`, log-scaled because crypto
  multiples span ~5x to >1000x): `x = clamp(log10(mcap/annualValue), 1, 3)`, then
  `score = clamp(10 − (x−1)·5, 0, 10)` → **≤10x → 10** (very cheap), **100x → 5** (fair),
  **≥1000x → 0** (expensive). Chosen so the current book (most tokens 7–50x revenue) lands
  in a sensible 7–10 band while a 1000x froth multiple zeroes out; revisit if the mix
  shifts. The TVL half (`scoreTvl`) keeps the existing 30d-trend (50%) + MC/TVL cheapness
  (50%), with revenue moved out to the multiple to avoid double-counting.
- **Emissions blend unchanged in shape:** `blendWithEmissions` keeps value 60 / emissions
  40 and the coverage factor (`5 + (raw−5)·present/2`). NOTE this **revises** the earlier
  "emissions-only capped at neutral 5.0" rule above: an emissions-only pillar now shrinks
  *halfway* toward neutral (e.g. emissions 9 → 7.0) rather than being hard-capped at 5.0.
  Rationale: with the category rule, value-less-but-covered tokens (e.g. LINK before its
  revenue is fetched) are rare and transient, and the symmetric shrink is simpler and
  consistent with how below-neutral inflation already passes through.
- **VIRTUAL before/after** (live snapshot, projected from stored raw): Fundamentals
  **4.5 → 7.1** (90x revenue multiple now drives it; value sub-score 1.0 → 5.2), final
  **5.1 → 6.5**. L1s rescored on chain fees gain +2.1–3.0 on Fundamentals. XRP/TRAC →
  Fundamentals null, score from Technicals.
- **LINK caveat:** historically stored with no `defillama_slug`, so no revenue is in the
  archive → it scores emissions-only (~5.8) until the `chainlink` slug is added and a
  fetch/backfill populates revenue; thereafter it is revenue-scored as `infra`.
- **History recompute** runs from stored raw (`tvl`, `holders_revenue`, `mcap = price ×
  circ_supply`, `emissions_rate`) — only `score_tvl_rev`/`score_fundamentals`/
  `final_score`/`reweighted` change, so the progression chart has no discontinuity.

## Chart line = historical percentile (not absolute score)
- **Two separate concepts, deliberately.** The **list** ranks tokens by the **absolute**
  blended score (cross-token comparison) — unchanged. The **chart line** plots each
  token's **historical percentile**: where each day's score sits versus that token's own
  complete history. Best day → 100 (top/buy zone), worst → ~0 (bottom/sell zone),
  median → ~50. This stretches the line across the full height instead of living in a
  narrow band (e.g. AVAX was stuck ~68–72% plotting the absolute average).
- **Percentile formula:** `percentile(v) = (count(scores ≤ v) − 1) / (n − 1) × 100`,
  computed over the token's entire reading history. Best day = 100 always; the worst day
  = 0 when its score is unique, or slightly above 0 when several days tie at the minimum
  (chosen so equal scores always plot at equal heights — no fabricated separation).
  Robust to outliers (a lone spike is just "the highest day", not a scale-blowing max).
- **Wiggle fix (critical).** The percentile is computed **once against the full, fixed
  history**, never against the visible window — so a given date's plotted value is
  identical at every range (7d/15d/30d/1y/all) and zoom; the window only changes *which*
  points are shown. The old "line moves in the past" came from the **double-tap fit-Y**,
  which rescaled the y-axis to the visible min/max (a window-dependent renormalization).
  That fit-Y behavior was removed; the y-axis is now fixed at 0–100. Double-tap/dbl-click
  resets pan/zoom instead.
- **Sell zone.** Mirror of the green buy zone: red gradient + dotted boundary below
  `SELL_ZONE = 35` (buy stays green above `GOOD_ZONE = 65`). Thresholds are symmetric
  around the 50th percentile; tune as desired.
- **Signal triangles removed** from the chart (the percentile line *is* the read:
  top = buy, bottom = sell). The `signals` table is retained in the DB — just not drawn.
- **Hover** shows both numbers: e.g. `AVAX · percentil 82% · score 6.4`, so the absolute
  reading isn't lost. Score and pillar math are untouched — only how the line is plotted.

## Market-cycle phase + phase-conditioned signals (Phase 1)
- **What it is.** A GLOBAL market-cycle detector (via BTC, not per-asset) classifying the
  market into 4 phases — `accumulation`, `rise`, `euphoria`, `correction` — stored in
  `market_cycle` (date, btc_price, phase, indicator_values), updated by the cron.
- **Phase 1 detector is a PLACEHOLDER (price/MA).** `lib/cycle.js`: long MA (200d where
  available, else longest window), distance above/below it, and 30d momentum:
  - `euphoria`: >40% above the long MA AND >10% 30d momentum.
  - `rise`: at/above the long MA.
  - `correction`: below the long MA and 30d momentum < 0 (still falling).
  - `accumulation`: below the long MA but momentum ≥ 0 (stabilizing).
  The reliable version (Phase 2) is **MVRV Z-Score / NUPL** — see below. The phase is a
  probabilistic CONTEXT, never a calendar/certainty.
- **Signal conditioning (the biggest lever).** The contrarian signals (RSI≤22/≥78 +
  cooldown + StochRSI/MACD confluence) are unchanged in nature, but a phase gate now
  decides whether a triggered candidate fires:
  - `accumulation` → BUYs only (sells suppressed)
  - `rise` → both
  - `euphoria` → SELLs only (buys suppressed)
  - `correction` → SELLs only — **buys suppressed** (stop buying the falling knife: this
    is what kept the system buying ONDO/AVAX into a structural decline)
  "Início de rise → só BUYs" from the brief is folded into `rise → both` for now
  (placeholder); refine with the MVRV detector in Phase 2. Each signal records its
  `cycle_phase` (audit).
- **Signal state machine fix.** A SELL now fires only when a position is OPEN (a prior
  BUY not yet closed) — no more orphan sells (13 tokens previously opened with a context-
  less SELL). A BUY opens/holds the position; a SELL closes it. Cooldown/position advance
  only on EMITTED signals (a phase-suppressed candidate doesn't reset them).
- **Alpha vs buy&hold** is the headline metric (preservation strategy): per asset and
  portfolio, strategy return − buy&hold return (pp), shown in the UI ("protegeu +Xpp vs
  segurar"). Strategy = $50 per BUY, sell all on SELL, open units marked at last price;
  benchmark = same capital bought at the first BUY and held.
- **Two charts** (tap the title): *Sinais de entrada* (the percentile line + buy/sell
  zones, no triangles) and *Ciclo de mercado* (BTC base-100 colored by phase + phase
  background bands + asset overlays base-100 on a log axis so BTC and altcoins are
  comparable). A discrete text regime banner states how the current phase conditions the
  signals.
- **NOT implemented (tested & rejected upstream):** fixed stop-loss, confidence-sizing,
  strategy-switching regime detector, automatic Elliott Wave. Guardrail respected.

## Phase 2 — robust price-only cycle detector (IMPLEMENTED; replaces the placeholder)
- **No paid MVRV.** Literal MVRV needs on-chain realized cap (paid). Instead `cycle.js` now
  combines FOUR indicators computed entirely from BTC daily price — measuring the same
  "price vs cycle cost-basis / over-under-valuation":
  1. **Mayer Multiple** = price / 200d MA (<0.8 cheap, 1.0–2.4 normal, >2.4 hot top).
  2. **200-week MA** (1400d Bull Market Support Band) — `ma200w_partial=true` honestly when
     <1400d of history exists (today we only have ~365d → it's the longest-available avg).
  3. **ATH drawdown** = (price − running ATH)/ATH (the Oct-2025 top is inside the 365d
     window, so drawdown is meaningful).
  4. **Price percentile** (point-in-time, expanding window — no lookahead).
- **Consensus, not one indicator.** The 2025 top printed Mayer ~2.2 (below the classic
  2.4) — institutionalization/ETFs made it less euphoric — so a single-indicator detector
  would miss it. Phase = consensus of the four (see `rawPhase`).
- **Hysteresis** — a phase only flips after the new condition holds ≥3 consecutive days
  (no day-to-day flip-flop). **Confidence (0–1)** from how extreme the dominant Mayer is,
  stored in `market_cycle.indicator_values.phase_confidence` and shown in the banner.
- **The Phase-1 gate is unchanged** (accumulation=buys / euphoria+correction=sells; correction
  still hard-blocks buys regardless of confidence). The detector only got smarter.
- **Honest limits.** 200W MA is `partial` until ~4 years of BTC accrue; price percentile is
  over the available window (~1yr), not all-time; the 2018/2021/2022 milestones can't be
  reproduced (out of the 365d window) — only the 2025 top + today are in range. A degenerate
  flat/at-ATH series reads euphoria (correct for real tops; not a concern for the current
  −52%-from-ATH market, which reads correction/accumulation).
- **Frontend.** Cycle chart adds a faint 200W-MA guide line (base-100); banner shows the
  current phase + confidence + Mayer.

## Phase 2.2 — asset survivorship filter (IMPLEMENTED)
- **Goal:** don't buy "ONDOs" — assets in a prolonged structural decline — even when the
  global cycle says accumulation. Per-asset (vs the GLOBAL BTC cycle gate).
- **Detection (`lib/survivorship.js`):** `structuralDecline = price < longMA AND longMA(now)
  < longMA(90d ago)` — price beneath a long (200d, capped to available history) MA that has
  itself been sloping down for ~90 days. Honest false during warmup.
- **Action:** suppresses **BUY** signals for flagged assets (in `generateSignals` /
  `detectLiveSignal`, after the cycle gate). Never blocks sells. The score/pillars and the
  list ranking are NOT changed (guardrail) — the asset is only **flagged** in the UI
  ("⚠ declínio estrutural · compras suprimidas") and its buys are withheld.

## Phase 2.3 — phase-based sizing + partial realization (IMPLEMENTED)
- Each signal carries a `size_mult` (`signals.size_mult`):
  - **BUY** → allocation multiplier: **accumulation 1.5×** (cycle bottom, max upside),
    **rise 1.0×**. (euphoria/correction buys are suppressed anyway.)
  - **SELL** → realization FRACTION (partial, non-binary): **euphoria 0.5** (let half ride),
    **else 1.0** (full).
- The alpha backtest sizes with it: BUY invests `$50 × size_mult`; SELL realizes a
  `size_mult` fraction of the open position. "DCA escalonado" is expressed as the larger
  accumulation allocation (the dashboard signals, it doesn't auto-execute staged orders).
  The regime banner shows the current sizing (e.g. "sizing 1.5× (fundo)").
- This does NOT change the signal generator/state machine or the confluence grading.

## Phase 2.1 — GLOBAL M2 liquidity confirmer (IMPLEMENTED)
- **What:** a true **global M2** = **US + Euro area + China** money supply, each converted
  to **USD** via ECB reference FX and summed monthly (~$94T as of 2026-06). The dominant
  crypto-liquidity driver. `lib/globalm2.js`.
- **Why not FRED:** the original plan used FRED's keyless `fredgraph.csv?id=M2SL`, but the
  St. Louis Fed **blocks cloud/datacenter IPs** (the fetch fails to connect from Vercel),
  and DBnomics **discontinued its FRED mirror**. So M2 never populated. The fix sources each
  region from a feed that *is* reachable from serverless, and upgrades US-only → genuinely
  global (what the metric is meant to represent).
- **Sources (all KEYLESS, server-side, reachable from Vercel):**
  - 🇺🇸 **US M2 (SA)** — Federal Reserve **H.6 Data Download Program** CSV
    (`datadownload/Output.aspx?rel=H6&series=798e2796…`), full monthly history, billions USD.
    (`federalreserve.gov` is reachable even though the `fred.stlouisfed.org` mirror is not.)
  - 🇪🇺 **Euro-area M2** — **ECB Data Portal** BSI dataflow
    (`BSI/M.U2.Y.V.M20.X.1.U2.2300.Z01.E`), millions EUR. CSV is CRLF — split on `\r?\n`.
  - 🇨🇳 **China M2** — **PBoC** English "Financial Statistics Report" monthly articles
    (parses "broad money supply (M2) stood at RMB X trillion, rising by Y percent"). History
    is short (~from 2025-10, the months the index lists).
  - 💱 **FX** — **ECB** EXR (`USD/EUR`, `CNY/EUR` → `USD/CNY`).
- **Metrics** (stored per market_cycle day in `indicator_values`, as-of, no lookahead):
  `m2_value` (global, USD T), `m2_yoy_pct` (size-weighted across regions — China's USD YoY =
  its stated CNY YoY compounded with the CNY→USD FX change, so it needs no long China
  history), `m2_expanding` (YoY > 0), per-region `m2_us`/`m2_eu`/`m2_cn` (USD T), and
  `m2_coverage` (e.g. `UEC`; degrades to `UE` for dates before China's history starts).
- **Use:** a displayed **CONFIRMER** only — banner shows "Liquidez M2 global ≈ $94.1 tri:
  a expandir (vento a favor) / a contrair (vento contra) · ±X% YoY (EUA · Zona Euro · China)".
  It does **not** change the phase gate or signal generation (kept safe/auditable).
- **Best-effort:** any source failing never blocks the cycle row (logged via `console.warn`).
  Populates on the next cron run (current) and a `backfill-cycle` re-run (per-day history).

## Phase 3 — long BTC history (complete 200W MA + 3-cycle validation) (IMPLEMENTED)
- **What:** imported BTC daily OHLC since **2011-08-18** (5,428 days) into a new
  `btc_history` table, and the cycle detector now computes the 200-week MA / Mayer /
  drawdown / expanding-window percentile over **10+ years** instead of ~1. So the
  200W MA is **complete** (`ma200w_partial=false`) for all recent dates (4,029 of 5,428
  rows; the first ~1,400 days are legitimately partial).
- **Source:** `api/import-btc-history.js` → **Bitstamp** `ohlc/btcusd` (keyless, daily since
  2011), Coinbase fallback. NOT Binance (geo-blocked from Vercel-US, 451), NOT CryptoCompare
  (now needs a key), NOT CoinGecko `days=max` (demo caps at 365d). Idempotent upsert by date.
- **Wiring:** `backfill-cycle` reads the full series via `sbSelectAll` (PostgREST caps a
  single response at 1000 rows → paginate) and recomputes `market_cycle` for all history;
  `cron-fetch` loads the long series, appends + persists today's live price into
  `btc_history`, and classifies over the complete history each run.
- **Threshold fix (validated against 3 real cycles):** an **extreme drawdown** (>60% off ATH
  with Mayer < 1.0) now reads **accumulation** (capitulation/bottom zone) even while still
  falling — placed ahead of the falling-knife correction rule. This flipped the 2015-01 /
  2018-12 / 2022-11 lows from `correction` to `accumulation`. Today's −52% sits above the
  threshold and correctly remains `correction`.
- **Validation (the acid test):** bottoms 2015/2018/2022 → `accumulation`; tops 2017/2021/
  2025 → `euphoria`; today → `correction` (Mayer 0.80, dd −52%). All 7 backbone milestones
  reconcile against the right OHLC field (note: the "$69k" 2021 top is the intraday HIGH;
  the "$172" 2015 low is the Jan-14 close). Phases 1+2 untouched: gate (0 buys in correction/
  euphoria), alpha, charts, technicals, M2 ($94.1T UEC), survivorship all intact. 66 tests.

## Phase 2 — complete
All Phase-2 items (robust detector, survivorship filter, phase sizing, M2 confirmer) are
implemented. Nothing outstanding.
- **Honest warnings.** (a) The long-term/cycle view only becomes reliable with YEARS of
  history; today there's ~1 year — it's built now and matures over time. (b) MVRV/NUPL are
  BTC = a GLOBAL traffic light, not per-asset. (c) The 4-year cycle is changing
  (institutionalization/ETFs) — probabilistic context, never a deterministic calendar.

## Excel export
- Client-side **SheetJS** (CDN, buildless). One sheet per token + a consolidated
  **Todos** + a **Legenda** first sheet. Activity cells are left BLANK (never 0)
  through the backfill period, and the Legenda states the exact date Activity
  collection began (or that it hasn't yet). Bold header cells aren't applied — the
  free SheetJS community build can't write cell styles; column widths + autofilter are.
