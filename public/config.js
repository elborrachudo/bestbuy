// public/config.js — frontend Supabase config (anon, read-only).
// These two values are safe to ship to the browser: RLS makes the anon key
// read-only (plus add/deactivate token, per 001_init.sql). NEVER put the
// service-role key here.
//
// Fill these in with your project's values from:
//   Supabase Dashboard → Project Settings → API
//     Project URL      → SUPABASE_URL
//     anon public key  → SUPABASE_ANON_KEY
window.BESTBUY_CONFIG = {
  SUPABASE_URL: 'https://swtkzbonnutfwsupadkh.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN3dGt6Ym9ubnV0ZndzdXBhZGtoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAwMzgyOTMsImV4cCI6MjA5NTYxNDI5M30.UoJ3WIdsDYyBI79H5336LfSkOUVBZcdVgQfBpinpNxI',
};
