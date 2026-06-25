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
