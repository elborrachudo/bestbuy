// lib/globalm2.js — GLOBAL M2 liquidity proxy = US + Euro area + China money supply, each
// converted to USD via ECB reference FX and summed, monthly. The dominant crypto-liquidity
// driver. KEYLESS and all sources are reachable from serverless (this exists because FRED's
// fredgraph.csv blocks datacenter IPs and DBnomics dropped the FRED mirror).
//
// Sources (all server-side, no API key):
//   • US M2 (SA)      — Federal Reserve H.6 Data Download Program CSV (billions USD).
//   • Euro-area M2    — ECB Data Portal, BSI dataflow (millions EUR).
//   • China M2        — People's Bank of China English "Financial Statistics Report"
//                       monthly articles (trillions RMB; the report also states YoY).
//   • FX (USD/EUR, CNY/EUR) — ECB Data Portal, EXR dataflow.
//
// Used ONLY as a displayed CONFIRMER (expanding global M2 = liquidity tailwind for dip-buys;
// contracting = headwind). It does NOT change the phase gate or the signals.

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'text/html,application/json,text/csv,*/*',
  'Accept-Language': 'en,zh;q=0.9',
};

async function fetchText(url, ms = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers: UA, signal: ctrl.signal });
    if (!r.ok) throw new Error(`${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

const round = (x, n = 4) => (x == null || !isFinite(x) ? null : Math.round(x * 10 ** n) / 10 ** n);
const shiftMonth = (ym, delta) => {          // 'YYYY-MM' shifted by `delta` months
  let [y, m] = ym.split('-').map(Number);
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
};
const ffAt = (map, ym) => {                   // forward-fill: latest value at month ≤ ym
  let v = null;
  for (const k of [...map.keys()].sort()) { if (k <= ym) v = map.get(k); else break; }
  return v;
};

// ── US M2 (seasonally adjusted), Fed H.6 DDP — billions USD → trillions USD ──────
const FED_M2_CSV =
  'https://www.federalreserve.gov/datadownload/Output.aspx?rel=H6&series=798e2796917702a5f8423426ba7e6b42' +
  '&lastobs=&from=&to=&filetype=csv&label=include&layout=seriescolumn&type=package';
export async function getUsM2() {             // → Map('YYYY-MM' → trillions USD)
  const csv = await fetchText(FED_M2_CSV);
  const lines = csv.split('\n');
  const hdr = lines.find((l) => l.startsWith('"Time Period"'));
  if (!hdr) throw new Error('us m2: no header');
  const codes = hdr.split(',').map((c) => c.replace(/"/g, '').trim());
  let col = codes.indexOf('M2.M');            // seasonally adjusted
  if (col < 0) col = codes.indexOf('M2_N.M'); // fallback: not seasonally adjusted
  if (col < 0) throw new Error('us m2: no M2 column');
  const out = new Map();
  for (const l of lines) {
    const m = /^(\d{4}-\d{2}),/.exec(l);
    if (!m) continue;
    const v = parseFloat(l.split(',')[col]);
    if (isFinite(v)) out.set(m[1], v / 1000);  // billions → trillions
  }
  return out;
}

// ── ECB Data Portal helper (BSI / EXR) ─────────────────────────────────────────
async function getEcb(key) {                  // → Map('YYYY-MM' → value)
  const csv = await fetchText(`https://data-api.ecb.europa.eu/service/data/${key}?format=csvdata&detail=dataonly`);
  const lines = csv.trim().split('\n');
  const h = lines[0].split(',');
  const ti = h.indexOf('TIME_PERIOD'), vi = h.indexOf('OBS_VALUE');
  const out = new Map();
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    const v = parseFloat(c[vi]);
    if (c[ti] && isFinite(v)) out.set(c[ti], v);
  }
  return out;
}
export const getEuM2 = () => getEcb('BSI/M.U2.Y.V.M20.X.1.U2.2300.Z01.E');  // millions EUR
export async function getFx() {               // { usdEur, cnyEur }: Map month → rate
  const [usdEur, cnyEur] = await Promise.all([
    getEcb('EXR/M.USD.EUR.SP00.A'),           // USD per EUR
    getEcb('EXR/M.CNY.EUR.SP00.A'),           // CNY per EUR
  ]);
  return { usdEur, cnyEur };
}

// ── China M2, PBoC English "Financial Statistics Report" articles ───────────────
const PBOC_INDEX = 'https://www.pbc.gov.cn/en/3688247/3688978/3709137/index.html';
const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
export async function getCnM2(maxArticles = 18) {  // → { lvl: Map(month→tn CNY), yoy: Map(month→pct) }
  const idx = await fetchText(PBOC_INDEX);
  const seen = new Set(); const arts = [];
  for (const mt of idx.matchAll(/<a[^>]*href="([^"]+)"[^>]*title="([^"]*Financial Statistics Report[^"]*)"/gi)) {
    const href = mt[1], title = mt[2];
    const ym = /\((January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\)/i.exec(title);
    if (!ym || seen.has(href)) continue;
    seen.add(href);
    arts.push({ href, year: ym[2], month: MONTHS[ym[1].toLowerCase()] });
  }
  const slice = arts.slice(0, maxArticles);
  const lvl = new Map(), yoy = new Map();
  await Promise.all(slice.map(async (a) => {
    try {
      const url = a.href.startsWith('http') ? a.href : 'https://www.pbc.gov.cn' + a.href;
      const txt = (await fetchText(url)).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
      const m = /broad money supply \(M2\) stood at RMB\s*([\d.,]+)\s*trillion[^.]*?by\s*([\d.]+)\s*percent/i.exec(txt);
      if (!m) return;
      const ym = `${a.year}-${String(a.month).padStart(2, '0')}`;
      const cny = parseFloat(m[1].replace(/,/g, ''));
      if (isFinite(cny)) { lvl.set(ym, cny); yoy.set(ym, parseFloat(m[2])); }
    } catch (e) { /* skip a bad article */ }
  }));
  return { lvl, yoy };
}

// ── Assemble all inputs once (slow: hits 4 sources), then read as-of cheaply ─────
export async function fetchGlobalM2Inputs() {
  const [us, eu, fx, cn] = await Promise.all([getUsM2(), getEuM2(), getFx(), getCnM2()]);
  return { us, eu, fx, cnLvl: cn.lvl, cnYoy: cn.yoy };
}

// USD trillions for each region at month ym (forward-filled). Returns {us,eu,cn,usdCny}.
function regionsUsdAt(inp, ym) {
  const usdEur = ffAt(inp.fx.usdEur, ym), cnyEur = ffAt(inp.fx.cnyEur, ym);
  const usdCny = (usdEur && cnyEur) ? usdEur / cnyEur : null;
  const usEur = null;
  const us = ffAt(inp.us, ym);                                   // already trillions USD
  const euM = ffAt(inp.eu, ym);
  const eu = (euM != null && usdEur) ? (euM * usdEur) / 1e6 : null;  // millions EUR → tn USD
  const cnC = ffAt(inp.cnLvl, ym);
  const cn = (cnC != null && usdCny) ? cnC * usdCny : null;          // tn CNY → tn USD
  return { us, eu, cn, usdCny };
}

// As-of metrics (no lookahead): global level (USD tn), size-weighted YoY %, expanding flag,
// per-region USD breakdown, and coverage string. Returns null if nothing is available.
export function globalM2MetricsAsOf(inp, asOf) {
  const ym = String(asOf).slice(0, 7);
  const now = regionsUsdAt(inp, ym);
  const prev = regionsUsdAt(inp, shiftMonth(ym, -12));
  const legs = [];
  // US YoY (USD)
  if (now.us != null) legs.push({ key: 'U', usd: now.us, yoy: prev.us ? now.us / prev.us - 1 : null });
  // EU YoY (USD)
  if (now.eu != null) legs.push({ key: 'E', usd: now.eu, yoy: prev.eu ? now.eu / prev.eu - 1 : null });
  // China YoY (USD) = stated CNY YoY compounded with the CNY→USD FX change.
  if (now.cn != null) {
    const cnyYoy = ffAt(inp.cnYoy, ym);
    const fxYoy = (now.usdCny && prev.usdCny) ? now.usdCny / prev.usdCny : null;
    const yoy = (cnyYoy != null && fxYoy != null) ? (1 + cnyYoy / 100) * fxYoy - 1
      : (prev.cn ? now.cn / prev.cn - 1 : null);
    legs.push({ key: 'C', usd: now.cn, yoy });
  }
  if (!legs.length) return null;
  const total = legs.reduce((a, l) => a + l.usd, 0);
  const wYoy = legs.filter((l) => l.yoy != null);
  const sumW = wYoy.reduce((a, l) => a + l.usd, 0);
  const yoyPct = sumW > 0 ? (wYoy.reduce((a, l) => a + l.usd * l.yoy, 0) / sumW) * 100 : null;
  return {
    m2_value: round(total, 2),                          // global M2, USD trillions
    m2_yoy_pct: round(yoyPct, 2),
    m2_expanding: yoyPct == null ? null : yoyPct > 0,
    m2_us: round(now.us, 2), m2_eu: round(now.eu, 2), m2_cn: round(now.cn, 2),
    m2_coverage: legs.map((l) => l.key).join(''),       // e.g. 'UEC'
  };
}

// Convenience for quick checks/tests.
export async function getGlobalM2Latest() {
  const inp = await fetchGlobalM2Inputs();
  const latest = [...inp.us.keys()].sort().slice(-1)[0];
  return { month: latest, ...globalM2MetricsAsOf(inp, `${latest}-15`) };
}
