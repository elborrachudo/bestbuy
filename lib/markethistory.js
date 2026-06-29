// lib/markethistory.js — import the cleaned Kaggle multi-coin daily history
// (data/market_history.csv.gz, ~29,210 rows, 10 coins, 2017→2026) into public.market_history.
// Idempotent upsert by (date,coin); empty CSV cells → NULL (not 0). source='kaggle_belbino_clean'.
//
// Lives in a lib (not its own API route) because the Hobby plan caps a deployment at 12
// Serverless Functions — it's invoked from api/import-btc-history.js via ?dataset=market-history.
// The gz is bundled with that function via vercel.json includeFiles.

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { sbUpsert } from './tokens.js';

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

export async function importMarketHistory(base, serviceKey) {
  const raw = readGz();
  const lines = raw.split(/\r?\n/).filter((l) => l.length);
  const header = lines[0].split(',');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(',');
    if (f.length !== header.length) continue;
    const row = { source: 'kaggle_belbino_clean' };
    for (let j = 0; j < header.length; j++) {
      const k = header[j], v = f[j];
      if (v === '' || v == null) { row[k] = null; continue; }
      if (TEXT.has(k)) { row[k] = v; }
      else { const n = Number(v); row[k] = Number.isFinite(n) ? n : null; }
    }
    rows.push(row);
  }
  if (!rows.length) throw new Error('no rows parsed');

  let up = 0;
  for (let i = 0; i < rows.length; i += 500) { await sbUpsert(base, serviceKey, 'market_history', rows.slice(i, i + 500), 'date,coin'); up += Math.min(500, rows.length - i); }
  const coins = {};
  for (const r of rows) coins[r.coin] = (coins[r.coin] || 0) + 1;
  return { ok: true, dataset: 'market-history', parsed: rows.length, upserted: up, first: rows[0].date, last: rows[rows.length - 1].date, coins };
}
