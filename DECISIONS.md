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
