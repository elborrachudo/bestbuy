// lib/marketdaily.js — the daily market-wide snapshot for public.market_daily.
//   A1 (live, fetched each run): total market cap, total + BTC 24h volume (CoinGecko /global +
//       /coins/markets), Fear & Greed Index (alternative.me — free, no key).
//   A3 (price-derived): Mayer, MAs (50d/200d/50w/200w), drawdown-from-ATH — computed from the
//       btc_history close series the cron already loads. MAs are NULL until their window is full
//       (no fabricated early values). cycle_phase comes from the detector (passed in by the cron).
// All best-effort: the cron wraps each call so a failure never blocks the rest of the run.

const CG = 'https://api.coingecko.com/api/v3';
const cgH = (k) => (k ? { 'x-cg-demo-api-key': k } : {});
const num = (x) => (typeof x === 'number' && isFinite(x) ? x : (x != null && isFinite(+x) ? +x : null));
const round2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const round4 = (x) => (x == null ? null : Math.round(x * 10000) / 10000);

async function getJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

// Live market totals + BTC 24h volume (2 CoinGecko calls).
export async function fetchMarketSnapshot(cgKey) {
  const g = await getJson(`${CG}/global`, { headers: cgH(cgKey) });
  const d = (g && g.data) || {};
  const m = await getJson(`${CG}/coins/markets?vs_currency=usd&ids=bitcoin`, { headers: cgH(cgKey) });
  const b = (Array.isArray(m) && m[0]) || {};
  return {
    total_mcap: num(d.total_market_cap && d.total_market_cap.usd),
    mkt_vol_24h: num(d.total_volume && d.total_volume.usd),
    btc_vol_24h: num(b.total_volume),
  };
}

// Fear & Greed Index — alternative.me, free, keyless. { value 0-100, label }.
export async function fetchFearGreed() {
  const j = await getJson('https://api.alternative.me/fng/?limit=1');
  const d = (j && j.data && j.data[0]) || {};
  return { value: d.value != null ? parseInt(d.value, 10) : null, label: d.value_classification || null };
}

function smaLast(arr, n) {
  if (!arr || arr.length < n) return null;
  let s = 0; for (let i = arr.length - n; i < arr.length; i++) s += arr[i];
  return s / n;
}

// Price-derived indicators from an ascending close series (full history incl. today's live close).
// Mirrors the SQL backfill: row-based MAs, NULL until the window is full; Mayer = close/200d MA;
// drawdown = close/running-ATH − 1 (≤0).
export function computeDerivables(closes) {
  const arr = (closes || []).filter((x) => typeof x === 'number' && isFinite(x));
  const n = arr.length; if (!n) return {};
  const last = arr[n - 1];
  const ma50 = smaLast(arr, 50), ma200 = smaLast(arr, 200), ma350 = smaLast(arr, 350), ma1400 = smaLast(arr, 1400);
  let ath = -Infinity; for (let i = 0; i < n; i++) if (arr[i] > ath) ath = arr[i];
  return {
    btc_close: round2(last),
    mayer: (ma200 && ma200 > 0) ? round4(last / ma200) : null,
    ma_50d: round2(ma50), ma_200d: round2(ma200), ma_50w: round2(ma350), ma_200w: round2(ma1400),
    drawdown_ath_pct: (ath > 0) ? round4(last / ath - 1) : null,
  };
}
