// api/import-market-history.js — one-shot import of the cleaned Kaggle multi-coin daily
// history (data/market_history.csv.gz, ~29,210 rows, 10 coins, 2017→2026) into
// public.market_history. Idempotent upsert by (date, coin); empty CSV cells → NULL (not 0).
// CRON_SECRET-protected. The gz is bundled with the function via vercel.json includeFiles.
//
// Trigger once: GET /api/import-market-history?secret=<CRON_SECRET>

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { sbUpsert } from '../lib/tokens.js';

const TEXT = new Set(['date', 'coin', 'fear_greed_label', 'fear_greed_zone']);
const here = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [
  path.join(process.cwd(), 'data/market_history.csv.gz'),
  path.join(here, '../data/market_history.csv.gz'),
  path.join(here, 'data/market_history.csv.gz'),
];

function readGz() {
  for (const c of CANDIDATES) { try { return zlib.gunzipSync(fs.readFileSync(c)).toString('utf8'); } catch (e) { /* next */ } }
  throw new Error('market_history.csv.gz not found in ' + JSON.stringify(CANDIDATES));
}

export default async function handler(req, res) {
  const base = process.env.SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !serviceKey) { res.status(500).json({ ok: false, error: 'missing supabase env' }); return; }
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const q = (req.query && req.query.secret) || '';
    if (q !== secret && (req.headers['authorization'] || '') !== `Bearer ${secret}`) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
  }

  let raw;
  try { raw = readGz(); } catch (e) { res.status(500).json({ ok: false, error: e.message }); return; }

  const lines = raw.split(/\r?\n/).filter((l) => l.length);
  const header = lines[0].split(',');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(',');
    if (f.length !== header.length) continue;   // skip any malformed line
    const row = { source: 'kaggle_belbino_clean' };
    for (let j = 0; j < header.length; j++) {
      const k = header[j], v = f[j];
      if (v === '' || v == null) { row[k] = null; continue; }
      if (TEXT.has(k)) { row[k] = v; }
      else { const n = Number(v); row[k] = Number.isFinite(n) ? n : null; }
    }
    rows.push(row);
  }
  if (!rows.length) { res.status(502).json({ ok: false, error: 'no rows parsed' }); return; }

  try {
    let up = 0;
    for (let i = 0; i < rows.length; i += 500) { await sbUpsert(base, serviceKey, 'market_history', rows.slice(i, i + 500), 'date,coin'); up += Math.min(500, rows.length - i); }
    const coins = {};
    for (const r of rows) coins[r.coin] = (coins[r.coin] || 0) + 1;
    res.status(200).json({
      ok: true, parsed: rows.length, upserted: up,
      first: rows[0].date, last: rows[rows.length - 1].date, coins,
    });
  } catch (e) {
    console.error('[import-market-history] failed:', e && e.stack ? e.stack : e);
    res.status(502).json({ ok: false, error: e.message });
  }
}
