// api/backfill.js — one-shot historical seed so the chart isn't empty on day one.
// For each active token: pull up to 365 days of daily price, reconstruct the
// price-based sub-scores per day from the real series, overlay fundamentals
// (per-day TVL from DefiLlama history; holders-revenue + supply held at current),
// and insert one is_backfill=true row per token per day at that day's 00:00 UTC.
//
// Honesty: backfill is 1 point/day (historical APIs don't give 3×/day); live is
// 3×/day going forward. Backfilled rows are stamped is_backfill=true.
//
// Protected: requires `?secret=<CRON_SECRET>` (or Authorization: Bearer) when
// CRON_SECRET is set, so it can't be triggered by the public. Optional query:
//   ?days=365   how far back to seed (capped at 365 by CoinGecko free tier)
//   ?reset=1    delete existing backfill rows for each token before reseeding

import { getActiveTokens, sbInsert, sbDelete } from '../lib/tokens.js';
import {
  getCoinGeckoPriceSeries, getCoinGeckoSupply,
  getDefiLlamaTvl, getDefiLlamaHoldersRevenueAnnual, tvlAtDate,
} from '../lib/sources.js';
import { sma, highLow, rsi, buildReading } from '../lib/scoring.js';

const DAY_SEC = 86400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dayStartUtcIso(ms) {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

export default async function handler(req, res) {
  const base = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const cgKey = process.env.COINGECKO_API_KEY || null;

  if (!base || !serviceKey) {
    res.status(500).json({ ok: false, error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' });
    return;
  }

  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers['authorization'] || '';
    const q = (req.query && req.query.secret) || '';
    if (auth !== `Bearer ${secret}` && q !== secret) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
  }

  const days = Math.min(parseInt((req.query && req.query.days) || '365', 10) || 365, 365);
  const reset = (req.query && req.query.reset) === '1';

  const summary = [];
  let tokens;
  try {
    tokens = await getActiveTokens(base, serviceKey);
  } catch (e) {
    res.status(500).json({ ok: false, error: `load tokens: ${e.message}` });
    return;
  }

  for (const t of tokens) {
    try {
      const series = await getCoinGeckoPriceSeries(t.coingecko_id, days, cgKey);
      if (!series.length) { summary.push({ symbol: t.symbol, error: 'no-price-series' }); continue; }
      const prices = series.map((p) => p.price);

      // Fundamentals overlay: per-day TVL from history; revenue + supply at current.
      let tvlSeries = null, holdersRevenue = null, circSupply = null, totalSupply = null;
      if (t.defillama_slug) {
        try { tvlSeries = (await getDefiLlamaTvl(t.defillama_slug)).series; } catch { /* market-only day */ }
        await sleep(400);
        try { holdersRevenue = await getDefiLlamaHoldersRevenueAnnual(t.defillama_slug); } catch { /* */ }
        await sleep(400);
      }
      try {
        const sup = await getCoinGeckoSupply(t.coingecko_id, cgKey);
        circSupply = sup.circSupply; totalSupply = sup.totalSupply;
      } catch { /* leave null → emissions sub null */ }

      if (reset) {
        await sbDelete(base, serviceKey, 'score_readings', `token_id=eq.${t.id}&is_backfill=eq.true`);
      }

      const rows = [];
      for (let i = 0; i < series.length; i++) {
        const ts = series[i].ts;
        const daySec = Math.floor(ts / 1000);
        const tvlNow = tvlSeries ? tvlAtDate(tvlSeries, daySec) : null;
        const tvl30dAgo = tvlSeries ? tvlAtDate(tvlSeries, daySec - 30 * DAY_SEC) : null;

        // Trailing 1-year high ending at day i. Capped at the data we have (≤365d),
        // so the oldest backfilled days use a shorter effective window than today.
        const high365 = highLow(prices, 365, i).high;
        const inputs = {
          price: prices[i],
          ma50: sma(prices, 50, i),
          ma200: sma(prices, 200, i),
          high365,
          rsi14: rsi(prices, 14, i),
          tvlNow, tvl30dAgo, holdersRevenue,
          circSupply, totalSupply,
          hasDefiSlug: !!t.defillama_slug,
        };
        const r = buildReading(inputs);
        if (r.final_score == null) continue;

        rows.push({
          token_id: t.id,
          fetched_at: dayStartUtcIso(ts),
          final_score: r.final_score,
          score_price_ma: r.score_price_ma,
          score_below_high: r.score_below_high,
          score_rsi: r.score_rsi,
          score_tvl_rev: r.score_tvl_rev,
          score_emissions: r.score_emissions,
          price: inputs.price,
          ma_50: inputs.ma50,
          ma_200: inputs.ma200,
          rsi_14: inputs.rsi14,
          tvl: tvlNow,
          holders_revenue: holdersRevenue,
          circ_supply: circSupply,
          emissions_rate: r.emissions_rate,
          reweighted: r.reweighted,
          is_backfill: true,
        });
      }

      // Insert in batches to stay under request-size limits.
      for (let i = 0; i < rows.length; i += 100) {
        await sbInsert(base, serviceKey, 'score_readings', rows.slice(i, i + 100));
      }
      summary.push({ symbol: t.symbol, days_seeded: rows.length, reweighted: rows.length ? rows[rows.length - 1].reweighted : null });
    } catch (e) {
      summary.push({ symbol: t.symbol, error: e.message });
    }
  }

  res.status(200).json({ ok: true, summary });
}
