// lib/tokens.js — thin Supabase REST (PostgREST) helpers. No SDK dependency.
// Server code passes the service-role key; reads also work with the anon key.

function sbHeaders(key) {
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

export async function sbSelect(base, key, path) {
  const res = await fetch(`${base}/rest/v1/${path}`, { headers: sbHeaders(key) });
  if (!res.ok) throw new Error(`Supabase select ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function sbInsert(base, key, table, rows) {
  const res = await fetch(`${base}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...sbHeaders(key), Prefer: 'return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase insert ${table}: ${res.status} ${await res.text()}`);
}

// Upsert rows (POST + on_conflict). On conflict, the provided columns are merged
// into the existing row. Used by the emissions recompute to update rows in place.
export async function sbUpsert(base, key, table, rows, onConflict) {
  const res = await fetch(`${base}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: { ...sbHeaders(key), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase upsert ${table}: ${res.status} ${await res.text()}`);
}

export async function sbDelete(base, key, table, filter) {
  const res = await fetch(`${base}/rest/v1/${table}?${filter}`, {
    method: 'DELETE',
    headers: { ...sbHeaders(key), Prefer: 'return=minimal' },
  });
  if (!res.ok) throw new Error(`Supabase delete ${table}: ${res.status} ${await res.text()}`);
}

export async function getActiveTokens(base, key) {
  return sbSelect(base, key, 'tracked_tokens?active=eq.true&select=*&order=created_at.asc');
}

// True if a reading for this token exists at or after `sinceIso` (idempotency guard).
export async function recentReadingExists(base, key, tokenId, sinceIso) {
  const rows = await sbSelect(
    base, key,
    `score_readings?token_id=eq.${tokenId}&fetched_at=gte.${encodeURIComponent(sinceIso)}&select=id&limit=1`
  );
  return rows.length > 0;
}

// Most recent LIVE reading that carries a raw on-chain activity snapshot, used as
// the baseline for the next snapshot's flow delta. null when none exists yet (the
// Activity score then stays null — no fabricated history). Returns the raw fields
// plus fetched_at so the caller can compute the inter-snapshot interval.
export async function getPrevActivitySnapshot(base, key, tokenId) {
  const rows = await sbSelect(
    base, key,
    `score_readings?token_id=eq.${tokenId}&source_tier=eq.live` +
    `&or=(holder_count.not.is.null,active_addresses.not.is.null)` +
    `&select=fetched_at,active_addresses,holder_count,transfer_count&order=fetched_at.desc&limit=1`
  );
  return rows.length ? rows[0] : null;
}
