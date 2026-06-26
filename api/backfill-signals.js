// api/backfill-signals.js — recompute the confluence indicators (StochRSI, MACD)
// for all stored readings and (re)generate the historical graded signals. Pure
// recompute from already-stored prices/rsi — NO source refetch. Independent of the
// continuous score and the three pillars (does not touch them).
//
// Protected like the other backfill: requires ?secret=<CRON_SECRET> (or Bearer) when
// CRON_SECRET is set. Optional ?symbol=LINK to process a single token.
//
// Per token: build a clean DAILY series (one row/day; indicators are daily), compute
// StochRSI + MACD, PATCH those 4 columns onto every reading of that day, then run the
// RSI trigger + 30d cooldown to (re)generate signals (is_backfill=true), replacing any
// prior backfill signals. Live signals (is_backfill=false) are left untouched.

import { getActiveTokens, sbSelect, sbInsert, sbDelete, sbPatch } from '../lib/tokens.js';
import { stochRsiSeries, macdSeries } from '../lib/scoring.js';
import { generateSignals } from '../lib/signals.js';

const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

// Update rows in parallel, capped, so a big token doesn't open hundreds of sockets.
async function patchInChunks(jobs, size = 20) {
  for (let i = 0; i < jobs.length; i += size) {
    await Promise.all(jobs.slice(i, i + size).map((fn) => fn()));
  }
}

export default async function handler(req, res) {
  const base = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
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
  const onlySymbol = ((req.query && req.query.symbol) || '').trim().toUpperCase();

  let tokens;
  try { tokens = await getActiveTokens(base, serviceKey); }
  catch (e) { res.status(500).json({ ok: false, error: `load tokens: ${e.message}` }); return; }
  if (onlySymbol) tokens = tokens.filter((t) => (t.symbol || '').toUpperCase() === onlySymbol);
  if (onlySymbol && !tokens.length) {
    res.status(404).json({ ok: false, error: `no active token with symbol ${onlySymbol}` });
    return;
  }

  const summary = [];
  for (const t of tokens) {
    try {
      // All readings for this token, ascending.
      const readings = await sbSelect(
        base, serviceKey,
        `score_readings?token_id=eq.${t.id}` +
        `&select=id,fetched_at,price,rsi_14,score_below_high,score_fundamentals,score_activity,is_backfill` +
        `&order=fetched_at.asc&limit=100000`
      );
      if (!readings.length) { summary.push({ symbol: t.symbol, skipped: 'no-readings' }); continue; }

      // Collapse to one representative row per UTC day (prefer backfill, else latest),
      // so the daily indicators line up with the daily price series.
      const byDay = new Map();
      for (const r of readings) {
        const day = r.fetched_at.slice(0, 10);
        const cur = byDay.get(day);
        if (!cur || (r.is_backfill && !cur.is_backfill) ||
            (r.is_backfill === cur.is_backfill && r.fetched_at > cur.fetched_at)) {
          byDay.set(day, r);
        }
      }
      const daily = [...byDay.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([day, r]) => ({ day, r }));
      const prices = daily.map((d) => (d.r.price == null ? null : Number(d.r.price)));
      // Some early rows can lack price; indicators need a contiguous price series, so
      // skip a token only if there's basically nothing to work with.
      if (prices.filter((p) => p != null).length < 27) {
        summary.push({ symbol: t.symbol, skipped: 'insufficient-price-history' });
        continue;
      }

      const stoch = stochRsiSeries(prices);
      const macd = macdSeries(prices);

      // Per-day indicator values, then PATCH onto EVERY reading of that day.
      const dayIndicators = new Map();
      daily.forEach((d, i) => {
        dayIndicators.set(d.day, {
          stochrsi_14: stoch[i] == null ? null : round1(stoch[i]),
          macd_line: macd.line[i], macd_signal: macd.signal[i], macd_histogram: macd.hist[i],
        });
      });
      const jobs = readings.map((r) => () => sbPatch(
        base, serviceKey, 'score_readings', `id=eq.${r.id}`, dayIndicators.get(r.fetched_at.slice(0, 10))
      ));
      await patchInChunks(jobs);

      // Generate signals from the enriched daily series (RSI trigger + cooldown).
      const enriched = daily.map((d, i) => ({
        fetched_at: d.r.fetched_at,
        rsi_14: d.r.rsi_14 == null ? null : Number(d.r.rsi_14),
        stochrsi_14: stoch[i] == null ? null : round1(stoch[i]),
        macd_histogram: macd.hist[i],
        score_below_high: d.r.score_below_high == null ? null : Number(d.r.score_below_high),
        score_fundamentals: d.r.score_fundamentals == null ? null : Number(d.r.score_fundamentals),
        score_activity: d.r.score_activity == null ? null : Number(d.r.score_activity),
        price: d.r.price == null ? null : Number(d.r.price),
      }));
      const signals = generateSignals(enriched).map((s) => ({ ...s, token_id: t.id, is_backfill: true }));

      // Replace prior backfill signals (idempotent); leave live signals intact.
      await sbDelete(base, serviceKey, 'signals', `token_id=eq.${t.id}&is_backfill=eq.true`);
      for (let i = 0; i < signals.length; i += 100) {
        if (signals.slice(i, i + 100).length) await sbInsert(base, serviceKey, 'signals', signals.slice(i, i + 100));
      }

      const perYear = {};
      for (const s of signals) { const y = s.signal_date.slice(0, 4); perYear[y] = (perYear[y] || 0) + 1; }
      summary.push({
        symbol: t.symbol, days: daily.length, rows_patched: readings.length,
        signals: signals.length, per_year: perYear,
        buys: signals.filter((s) => s.side === 'BUY').length,
        sells: signals.filter((s) => s.side === 'SELL').length,
      });
    } catch (e) {
      summary.push({ symbol: t.symbol, error: e.message });
    }
  }

  res.status(200).json({ ok: true, summary });
}
