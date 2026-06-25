# BestBuy

A mobile-first crypto **BestBuy** scoring dashboard. Three times a day it fetches
market + fundamental data for a user-defined set of tokens, computes a 1–10
"BestBuy" score per token (10 = strong buy), stores every reading in Supabase,
and renders a ranked list + a score-progression chart with tap-to-expand raw
readings.

**Stack:** GitHub + Vercel (cron + static hosting) + Supabase (Postgres).
**Data:** CoinGecko + DefiLlama (free tiers). **Frontend:** one static page
(vanilla JS + Chart.js via CDN) — no build step.

> Decision-support only. Not financial advice. No trading, no buy buttons.

---

## How it works

- `api/cron-fetch.js` runs at **00:00, 08:00, 16:00 UTC** (Vercel cron). For each
  active token it pulls CoinGecko price/supply + DefiLlama TVL/holders-revenue,
  computes five sub-scores, combines them by weight, and writes one
  `score_readings` row.
- `api/backfill.js` seeds **up to 365 days of daily history** once after deploy so
  the chart isn't empty. Backfilled rows are stamped `is_backfill = true`
  (1 point/day; live data is 3×/day going forward).
- `lib/scoring.js` is pure (and unit-tested) — shared by cron and backfill.
- `public/index.html` reads from Supabase with the **anon key** (read-only via RLS).

### Scoring (1–10, 10 = strong buy)

| Input | Weight | If no DeFi data (reweighted) |
|---|---|---|
| Price vs 50/200d MAs | 25% | 42% |
| % below 1-year high (contrarian) | 20% | 33% |
| RSI 14d (oversold scores high) | 15% | 25% |
| TVL trend + holders-revenue value | 25% | dropped |
| Emissions vs supply (low inflation high) | 15% | dropped |

Tokens with no `defillama_slug` (or whose fundamental fetches fail) are
**auto-reweighted** to market-only and flagged in the UI. Verdict bands:
8.0+ STRONG BUY · 6.5–7.9 BUY · 4.5–6.4 NEUTRAL · 3.0–4.4 WEAK · <3 AVOID.

---

## Setup

### 1. Supabase
1. Create a project at https://supabase.com/dashboard.
2. Open **SQL Editor → New query**, paste all of `sql/001_init.sql`, click **Run**.
   This creates both tables, indexes, RLS policies, and seeds the four starting
   tokens (AERO, XRP, CRV, ONDO).
3. From **Project Settings → API** copy: the **Project URL**, the **anon** key,
   and the **service_role** key.

### 2. Frontend config
Edit `public/config.js` and paste your **Project URL** + **anon** key. (Safe to
ship — RLS keeps the anon key read-only.)

### 3. Vercel
1. Import the GitHub repo at https://vercel.com/new.
2. Framework preset: **Other**. No build command. Output dir: `public`.
3. **Settings → Environment Variables** — add:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`  *(server-side only — used by cron + backfill)*
   - `COINGECKO_API_KEY` *(optional)*
   - `CRON_SECRET` *(optional but recommended — protects the backfill route)*
   Deploy.
4. The cron schedule in `vercel.json` registers automatically on deploy
   (requires a Vercel plan that includes Cron Jobs).

### 4. Seed history + first live reading
- **Backfill (once):** visit `https://<your-app>.vercel.app/api/backfill?secret=<CRON_SECRET>`
  (omit `?secret=` if you didn't set `CRON_SECRET`). Add `&reset=1` to wipe and
  reseed. Expect ~365 rows/token (younger tokens start at their launch).
- **First live reading:** visit `https://<your-app>.vercel.app/api/cron-fetch`
  (with the `Authorization: Bearer <CRON_SECRET>` header if set), or just wait for
  the next scheduled slot.

---

## Add / remove tokens

From the dashboard's **Manage tokens** dropdown:
- **+ add new token** → enter symbol, CoinGecko id, optional DefiLlama slug + hex
  color. Inserts a row into `tracked_tokens`; the **next cron run scores it
  automatically**.
- **Remove** → sets `active = false` (history preserved, tracking stops).

Crypto only. To find ids: CoinGecko id is in the coin's URL
(`coingecko.com/en/coins/<id>`); DefiLlama slug is in the protocol URL
(`defillama.com/protocol/<slug>`).

---

## Local dev

```bash
node lib/scoring.test.js   # run the scoring unit tests (no deps)
```

The frontend is static — open `public/index.html` via any static server after
filling in `public/config.js`.

## Files

```
public/index.html   dashboard (static, Supabase anon reads)
public/config.js    frontend Supabase URL + anon key
api/cron-fetch.js   3×/day fetch + score + store (service role)
api/backfill.js     one-shot 12-month daily seed
lib/scoring.js      pure scoring + indicators (unit-tested)
lib/sources.js      CoinGecko + DefiLlama fetch helpers
lib/tokens.js       Supabase REST helpers
sql/001_init.sql    schema + RLS + indexes + seed
vercel.json         cron schedule + function config
```
