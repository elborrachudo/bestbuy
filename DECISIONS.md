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
- Fix: a coverage factor in `scoreFundamentals`. `coverage = nComponentsPresent / 2`;
  with one component the score is shrunk toward the neutral 5.0:
  `adjusted = 5 + (raw − 5) × coverage`. Both present → unchanged. XRP's Fundamentals
  fell 8.3 → 6.7 and its final 7.0 → 6.1 (now BUY, clustered with CRV/AERO, not a
  lone STRONG BUY). Pillar-level reweight (Fundamentals fully null) is unchanged.
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

## Excel export
- Client-side **SheetJS** (CDN, buildless). One sheet per token + a consolidated
  **Todos** + a **Legenda** first sheet. Activity cells are left BLANK (never 0)
  through the backfill period, and the Legenda states the exact date Activity
  collection began (or that it hasn't yet). Bold header cells aren't applied — the
  free SheetJS community build can't write cell styles; column widths + autofilter are.
