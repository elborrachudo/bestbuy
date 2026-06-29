// lib/dominance.js — reconstruct + maintain the daily market-dominance series
// (BTC.D / ETH.D / STABLE.D / OTHERS.D) from CoinGecko's FREE/demo tier.
//
// Source & honesty notes (CoinGecko free, x-cg-demo-api-key):
//   • Per-coin daily market cap comes from /coins/{id}/market_chart?days=max&interval=daily.
//     On the demo tier the historical window is capped (~365 days). We request `max`
//     and store WHATEVER actually comes back — the caller reports the real first→last.
//   • There is NO free historical TOTAL market cap (CoinGecko's /global/market_cap_chart
//     is Pro-only). So the historical TOTAL is APPROXIMATED as the sum of a basket of the
//     top-N coins by current market cap, then scaled by a single calibration factor
//     (present authoritative /global total ÷ present basket sum) to account for the long
//     tail not in the basket. This is documented as an approximation.
//   • The daily cron (cron-dominance) uses the AUTHORITATIVE present /global total for the
//     current day instead of the calibrated basket, so the live edge is exact.
//
// Dominance = group market cap ÷ total market cap × 100. OTHERS.D = 100 − BTC.D − ETH.D − STABLE.D.

const CG_BASE = 'https://api.coingecko.com/api/v3';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dstr = (ms) => new Date(ms).toISOString().slice(0, 10);

// Documented stablecoin basket (CoinGecko ids). USD-pegged, fully-collateralised or
// crypto-collateralised majors. Algorithmic/depegged legacy coins (e.g. BUSD, UST) are
// intentionally excluded. STABLE.D = sum of the market caps of those present in the data.
export const STABLE_IDS = [
  'tether',            // USDT
  'usd-coin',          // USDC
  'dai',               // DAI
  'ethena-usde',       // USDe
  'first-digital-usd', // FDUSD
  'true-usd',          // TUSD
  'paypal-usd',        // PYUSD
  'usds',              // USDS (Sky Dollar)
  'frax',              // FRAX
  'gemini-dollar',     // GUSD
];

function cgHeaders(apiKey) {
  return apiKey ? { 'x-cg-demo-api-key': apiKey } : {};
}

// Fetch JSON with retries on 429 / network error (CoinGecko rate-limit friendly).
// Exponential backoff with jitter so concurrent-ish retries don't resync into the limit.
async function cgJson(url, apiKey, { retries = 4, delayMs = 2000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: cgHeaders(apiKey) });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(delayMs * (attempt + 1) + Math.floor(Math.random() * 500));
        continue;
      }
      if (!res.ok) throw new Error(`${url.replace(/api_key=[^&]*/i, 'api_key=…')} → ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt < retries) { await sleep(delayMs * (attempt + 1) + Math.floor(Math.random() * 500)); continue; }
      throw err;
    }
  }
}

// Present top-N coins by market cap → [{ id, mcap }]. One call covers up to 250 coins.
export async function fetchTopCoins(apiKey, n = 100) {
  const per = Math.min(n, 250);
  const url = `${CG_BASE}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${per}&page=1&sparkline=false`;
  const arr = await cgJson(url, apiKey);
  return (arr || [])
    .filter((c) => c && c.id && typeof c.market_cap === 'number' && c.market_cap > 0)
    .map((c) => ({ id: c.id, mcap: c.market_cap }));
}

// Present global snapshot → { total, pct } where pct is market_cap_percentage by symbol.
export async function fetchGlobalNow(apiKey) {
  const j = await cgJson(`${CG_BASE}/global`, apiKey);
  const d = (j && j.data) || {};
  return {
    total: (d.total_market_cap && Number(d.total_market_cap.usd)) || null,
    pct: d.market_cap_percentage || {},
  };
}

// Daily market-cap series for one coin → Map<dateStr, mcap>. Requests the MAX window
// the free tier allows (demo caps ~365d) and keeps whatever is returned. Last sample of
// each day wins. Returns an empty map on failure (caller decides how to degrade).
export async function fetchCoinDailyMcap(id, apiKey) {
  const url = `${CG_BASE}/coins/${id}/market_chart?vs_currency=usd&days=max&interval=daily`;
  const j = await cgJson(url, apiKey);
  const caps = (j && j.market_caps) || [];
  const out = new Map();
  for (const [ts, mc] of caps) {
    if (typeof mc === 'number' && mc > 0) out.set(dstr(ts), mc);
  }
  return out;
}

// ── Historical reconstruction ────────────────────────────────────────────────
// Builds the full daily dominance series. Fetches per-coin daily market caps for the
// top-N coins (plus every stablecoin in STABLE_IDS, even if outside the top-N), sums a
// per-day basket as the TOTAL proxy, calibrates it to the present authoritative /global
// total, then derives BTC.D / ETH.D / STABLE.D / OTHERS.D per day.
//
// opts: { topN=50, pauseMs=2200, deadlineMs=240000, onProgress }
// returns { rows, meta } — rows ascending by date; meta documents depth + calibration.
//
// Pacing: CoinGecko's demo tier allows ~30 calls/min, so pauseMs defaults to 2200 (~24/min).
// Robustness: a soft wall-clock deadline (default 240s, leaving headroom under Vercel's 300s)
// stops the per-coin loop early and computes with whatever was gathered — so the job always
// WRITES rows instead of timing out with nothing. btc+eth are fetched first so an early stop
// still yields a usable (if smaller-basket) series.
export async function buildDominanceSeries(apiKey, opts = {}) {
  const startedAt = Date.now();
  const topN = opts.topN || 35;
  const pauseMs = opts.pauseMs == null ? 2500 : opts.pauseMs;
  const deadlineMs = opts.deadlineMs == null ? 240000 : opts.deadlineMs;
  const log = (m) => { try { console.log(`[dominance] ${m}`); } catch (_) {} };

  // Fetch the two single-shot calls FIRST, while the rate-limit budget is freshest, and
  // degrade gracefully if either fails — a later failure must never discard a fetched basket.
  let topIds = [];
  try { topIds = (await fetchTopCoins(apiKey, topN)).map((c) => c.id); log(`top coins: ${topIds.length}`); }
  catch (e) { log(`fetchTopCoins failed (${e.message}) — falling back to essentials only`); }
  await sleep(pauseMs);

  let globalNow = { total: null, pct: {} };
  try { globalNow = await fetchGlobalNow(apiKey); log(`global total: ${globalNow.total}`); }
  catch (e) { log(`fetchGlobalNow failed (${e.message}) — total falls back to raw basket sum`); }
  await sleep(pauseMs);

  // Coin set = {bitcoin, ethereum} ∪ stablecoins ∪ top-N (deduped, order preserved). BTC/ETH and
  // the stablecoin basket lead so a deadline-truncated run still has the essentials.
  const ids = [...new Set(['bitcoin', 'ethereum', ...STABLE_IDS, ...topIds])];

  const series = new Map();      // id → Map<date, mcap>
  const fetched = [];
  const failed = [];
  let truncatedByDeadline = false;
  for (let i = 0; i < ids.length; i++) {
    if (Date.now() - startedAt > deadlineMs) { truncatedByDeadline = true; log(`deadline hit at ${i}/${ids.length}`); break; }
    const id = ids[i];
    try {
      const m = await fetchCoinDailyMcap(id, apiKey);
      if (m.size) { series.set(id, m); fetched.push(id); }
      else failed.push(id);
    } catch (e) { failed.push(`${id}:${e.message}`); }
    if (opts.onProgress) opts.onProgress(i + 1, ids.length, id);
    if (pauseMs && i < ids.length - 1) await sleep(pauseMs);
  }
  log(`fetched ${fetched.length}/${ids.length} coins, ${failed.length} failed`);

  const btc = series.get('bitcoin');
  const eth = series.get('ethereum');
  if (!btc || !eth) throw new Error(`missing btc/eth series (btc=${!!btc} eth=${!!eth}); fetched=${fetched.length} failed=${JSON.stringify(failed.slice(0, 8))}`);

  const stableIdsPresent = STABLE_IDS.filter((id) => series.has(id));

  // Union of all dates that have at least a BTC value.
  const dates = [...btc.keys()].sort();

  const latest = dates[dates.length - 1];
  const basketAt = (date) => {
    let s = 0;
    for (const [, m] of series) { const v = m.get(date); if (typeof v === 'number') s += v; }
    return s;
  };
  const basketLatest = basketAt(latest);
  const calibrated = !!(globalNow.total && basketLatest > 0);
  const calib = calibrated ? globalNow.total / basketLatest : 1;
  const srcTag = calibrated ? 'cg-basket-calib' : 'cg-basket-raw';

  const rows = [];
  for (const date of dates) {
    const mcapBtc = btc.get(date);
    const mcapEth = eth.get(date);
    if (typeof mcapBtc !== 'number' || typeof mcapEth !== 'number') continue;
    let mcapStable = 0;
    for (const id of stableIdsPresent) { const v = series.get(id).get(date); if (typeof v === 'number') mcapStable += v; }
    const basket = basketAt(date);
    if (!(basket > 0)) continue;
    const mcapTotal = basket * calib;
    const btc_d = (mcapBtc / mcapTotal) * 100;
    const eth_d = (mcapEth / mcapTotal) * 100;
    const stable_d = (mcapStable / mcapTotal) * 100;
    const others_d = Math.max(0, 100 - btc_d - eth_d - stable_d);
    rows.push({
      date,
      btc_d: round3(btc_d), eth_d: round3(eth_d), stable_d: round3(stable_d), others_d: round3(others_d),
      mcap_btc: Math.round(mcapBtc), mcap_eth: Math.round(mcapEth),
      mcap_stable: Math.round(mcapStable), mcap_total: Math.round(mcapTotal),
      source: srcTag,
    });
  }

  const meta = {
    topN, requested: ids.length, fetched: fetched.length, failed,
    truncated_by_deadline: truncatedByDeadline,
    elapsed_ms: Date.now() - startedAt,
    stablecoins_used: stableIdsPresent,
    basket_coins: fetched.length,
    calibration_factor: round4(calib),
    present_global_total: globalNow.total,
    present_basket_sum: Math.round(basketLatest),
    first: rows.length ? rows[0].date : null,
    last: rows.length ? rows[rows.length - 1].date : null,
    days: rows.length,
  };
  return { rows, meta };
}

// ── Daily snapshot (cron) ─────────────────────────────────────────────────────
// Today's row using the AUTHORITATIVE present /global total. Two calls only:
//   • /coins/markets — current mcaps for btc, eth and every stablecoin in the basket.
//   • /global        — authoritative present total market cap.
// Idempotent: caller upserts by date.
export async function fetchDominanceSnapshot(apiKey) {
  const top = await fetchTopCoins(apiKey, 250);
  const byId = new Map(top.map((c) => [c.id, c.mcap]));
  const mcapBtc = byId.get('bitcoin');
  const mcapEth = byId.get('ethereum');
  if (!mcapBtc || !mcapEth) throw new Error('global markets missing btc/eth');
  const stableIdsPresent = STABLE_IDS.filter((id) => byId.has(id));
  let mcapStable = 0;
  for (const id of stableIdsPresent) mcapStable += byId.get(id);

  const globalNow = await fetchGlobalNow(apiKey);
  const mcapTotal = globalNow.total || [...byId.values()].reduce((a, b) => a + b, 0);

  const btc_d = (mcapBtc / mcapTotal) * 100;
  const eth_d = (mcapEth / mcapTotal) * 100;
  const stable_d = (mcapStable / mcapTotal) * 100;
  const others_d = Math.max(0, 100 - btc_d - eth_d - stable_d);
  return {
    date: dstr(Date.now()),
    btc_d: round3(btc_d), eth_d: round3(eth_d), stable_d: round3(stable_d), others_d: round3(others_d),
    mcap_btc: Math.round(mcapBtc), mcap_eth: Math.round(mcapEth),
    mcap_stable: Math.round(mcapStable), mcap_total: Math.round(mcapTotal),
    source: 'cg-global', _stablecoins_used: stableIdsPresent,
  };
}

function round3(x) { return Math.round(x * 1000) / 1000; }
function round4(x) { return Math.round(x * 10000) / 10000; }
