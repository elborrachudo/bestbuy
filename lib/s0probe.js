// S0 gate probe (TEMPORARY, read-only): network reachability + engine smoke run. Identical file on both hosts (Vercel preview / Supabase Edge).
// Only GET/HEAD/POST-to-read calls to public endpoints. Writes nothing anywhere.
const HL = 'https://api.hyperliquid.xyz/info';
const BV = 'https://data.binance.vision/data/futures/um/monthly/klines/BTCUSDT/1m/';
const LIST = 'https://s3-ap-northeast-1.amazonaws.com/data.binance.vision?delimiter=/&prefix=data/futures/um/monthly/klines/BTCUSDT/1m/';
async function timed(fn) { const t0 = Date.now(); try { const v = await fn(); return { ms: Date.now() - t0, ...v }; } catch (e) { return { ms: Date.now() - t0, error: String(e && e.message || e) }; } }
async function post(body) { const r = await fetch(HL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch (_) {} return { status: r.status, j, txt: j ? null : txt.slice(0, 200) }; }
function candleInfo(rows, now) {
  if (!Array.isArray(rows)) return { rows: null };
  const asc = rows.every((r, i) => i === 0 || r.t > rows[i - 1].t);
  const last = rows[rows.length - 1];
  return { rows: rows.length, fields: rows.length ? Object.keys(rows[0]).sort() : [], sample: rows.length ? rows[0] : null,
    firstT: rows.length ? new Date(rows[0].t).toISOString() : null, lastT: last ? new Date(last.t).toISOString() : null,
    lastCloseT: last ? new Date(last.T).toISOString() : null, lastStillForming: last ? last.T >= now : null, ascending: asc,
    pricesAreStrings: rows.length ? typeof rows[0].c === 'string' : null };
}
export async function runProbe(E, host) {
  const now = Date.now(), out = { host, at: new Date(now).toISOString() };
  out.geo = await timed(async () => { const r = await fetch('https://www.cloudflare.com/cdn-cgi/trace'); const t = await r.text(); const g = {}; t.split('\n').forEach((l) => { const [k, v] = l.split('='); if (['loc', 'colo'].includes(k)) g[k] = v; }); return { status: r.status, ...g }; });
  out.hl_1m_10days = await timed(async () => { const r = await post({ type: 'candleSnapshot', req: { coin: 'BTC', interval: '1m', startTime: now - 10 * 86400e3, endTime: now } }); return { status: r.status, ...candleInfo(r.j, now), raw: r.txt }; });
  out.hl_1m_2h = await timed(async () => { const r = await post({ type: 'candleSnapshot', req: { coin: 'BTC', interval: '1m', startTime: now - 2 * 3600e3, endTime: now } }); return { status: r.status, ...candleInfo(r.j, now), raw: r.txt }; });
  for (const iv of ['5m', '15m', '1h', '4h', '1d']) {
    out['hl_' + iv + '_since2015'] = await timed(async () => { const r = await post({ type: 'candleSnapshot', req: { coin: 'BTC', interval: iv, startTime: Date.UTC(2015, 0, 1), endTime: now } }); const i = candleInfo(r.j, now); delete i.sample; return { status: r.status, ...i, raw: r.txt }; });
  }
  out.hl_funding_3d = await timed(async () => { const r = await post({ type: 'fundingHistory', coin: 'BTC', startTime: now - 3 * 86400e3 }); const a = r.j;
    return { status: r.status, rows: Array.isArray(a) ? a.length : null, fields: Array.isArray(a) && a.length ? Object.keys(a[0]).sort() : [], sample: Array.isArray(a) && a.length ? a[a.length - 1] : null,
      intervalMin: Array.isArray(a) && a.length > 1 ? Math.round((a[a.length - 1].time - a[a.length - 2].time) / 60000) : null, ascending: Array.isArray(a) ? a.every((x, i) => i === 0 || x.time > a[i - 1].time) : null, raw: r.txt }; });
  out.hl_funding_120d = await timed(async () => { const r = await post({ type: 'fundingHistory', coin: 'BTC', startTime: now - 120 * 86400e3 }); const a = r.j;
    return { status: r.status, rows: Array.isArray(a) ? a.length : null, firstT: Array.isArray(a) && a.length ? new Date(a[0].time).toISOString() : null, lastT: Array.isArray(a) && a.length ? new Date(a[a.length - 1].time).toISOString() : null }; });
  const prev = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() - 1, 1)); const ym = prev.toISOString().slice(0, 7);
  out.binance_zip_head = await timed(async () => { const r = await fetch(BV + 'BTCUSDT-1m-' + ym + '.zip', { method: 'HEAD' }); return { file: 'BTCUSDT-1m-' + ym + '.zip', status: r.status, bytes: r.headers.get('content-length'), lastModified: r.headers.get('last-modified') }; });
  out.binance_checksum = await timed(async () => { const r = await fetch(BV + 'BTCUSDT-1m-' + ym + '.zip.CHECKSUM'); const t = await r.text(); return { status: r.status, text: t.trim().slice(0, 120) }; });
  out.binance_listing = await timed(async () => { const r = await fetch(LIST); const t = await r.text(); const keys = [...t.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1].split('/').pop()).filter((k) => k.endsWith('.zip'));
    return { status: r.status, zips: keys.length, earliest: keys[0] || null, latest: keys[keys.length - 1] || null, truncated: /<IsTruncated>true/.test(t) }; });
  out.engine = await timed(async () => { const r = await post({ type: 'candleSnapshot', req: { coin: 'BTC', interval: '1h', startTime: now - 20 * 86400e3, endTime: now } });
    const closed = (r.j || []).filter((k) => k.T < now).map((k) => ({ t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v }));
    const t0 = Date.now(); const res = E.analyze(closed, { symbol: 'BTC', timeframe: '1h' }); const cpu = Date.now() - t0;
    return { version: E.VERSION, bars: closed.length, analyzeMs: cpu, decision: res.decision, regime: res.regime && res.regime.label, primary: res.primary ? { type: res.primary.type, status: res.primary.status, fill: res.primary.fill, stop: res.primary.stop, tp1: res.primary.tp1 } : null }; });
  out.totalMs = Date.now() - now;
  return out;
}
