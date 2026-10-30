-- Name Exposure Scanner schema. Stores URLs, text snippets and classifier output only. Never images.
CREATE TABLE IF NOT EXISTS scans (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  full_name TEXT NOT NULL,
  name_norm TEXT NOT NULL,
  variants_json TEXT NOT NULL DEFAULT '[]',
  context_json TEXT NOT NULL DEFAULT '{}',
  email TEXT,
  is_minor INTEGER NOT NULL DEFAULT 0,
  harm_types_json TEXT NOT NULL DEFAULT '[]',
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planning',   -- planning | searching | awaiting_import | classifying | done | paused_budget | error
  error TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  ip_hash TEXT,
  utm TEXT,
  serp_queries INTEGER NOT NULL DEFAULT 0,
  in_tokens INTEGER NOT NULL DEFAULT 0,
  out_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_scans_name ON scans(name_norm, created_at);
CREATE INDEX IF NOT EXISTS idx_scans_ip ON scans(ip_hash, created_at);

CREATE TABLE IF NOT EXISTS queries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id TEXT NOT NULL,
  q TEXT NOT NULL,
  priority INTEGER NOT NULL,     -- 1 sexual/leak, 2 accusation/crime, 3 doxxing/general, 4 site-scoped
  source TEXT NOT NULL,          -- seed | ai | related | site
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | done | skipped
  results INTEGER NOT NULL DEFAULT 0,
  UNIQUE(scan_id, q)
);
CREATE INDEX IF NOT EXISTS idx_queries_scan ON queries(scan_id, status, priority);

CREATE TABLE IF NOT EXISTS hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'web',   -- web | autocomplete
  url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  domain TEXT NOT NULL,
  title TEXT,
  snippet TEXT,
  source_query TEXT,
  context_text TEXT,
  fetch_state TEXT NOT NULL DEFAULT 'pending',  -- pending | fetched | blocked | failed | skipped
  classified INTEGER NOT NULL DEFAULT 0,
  category TEXT,
  severity INTEGER,
  match_confidence REAL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'found', -- found | not_me | resolved | drafted | sent | removed | refused | escalated
  created_at INTEGER NOT NULL,
  UNIQUE(scan_id, canonical_url)
);
CREATE INDEX IF NOT EXISTS idx_hits_scan ON hits(scan_id, classified);

CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id TEXT NOT NULL,
  hit_id INTEGER NOT NULL,
  template TEXT NOT NULL,
  channel_json TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id TEXT,
  kind TEXT NOT NULL,          -- unlock | help
  help_type TEXT,              -- legal | investigator | pr | unsure
  name TEXT,
  email TEXT NOT NULL,
  message TEXT,
  hit_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS serp_cache (
  key TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_daily (
  day TEXT PRIMARY KEY,
  serp_queries INTEGER NOT NULL DEFAULT 0,
  in_tokens INTEGER NOT NULL DEFAULT 0,
  out_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0
);

-- Connect shared cached search data to scans so deletion removes cached snippets.
CREATE TABLE IF NOT EXISTS scan_cache (
  scan_id TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  PRIMARY KEY (scan_id, cache_key)
);

-- Aggregate rate limits survive scan deletion; no names, URLs or scan IDs here.
CREATE TABLE IF NOT EXISTS ip_daily (
  day TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  scans INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, ip_hash)
);

-- URL-only reporting cases are separate from search hits: source pages and media
-- are never fetched. Drafts are derived from these fields, not from page content.
CREATE TABLE IF NOT EXISTS takedown_cases (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  affected_name TEXT NOT NULL,
  reporter_name TEXT NOT NULL,
  reporter_email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('self', 'representative')),
  authority_confirmed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS takedown_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL REFERENCES takedown_cases(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  host TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'sent', 'followed_up', 'removed', 'refused', 'escalated')),
  sent_at INTEGER,
  due_at INTEGER,
  followed_up_at INTEGER,
  reference TEXT NOT NULL DEFAULT '',
  UNIQUE(case_id, url)
);
CREATE INDEX IF NOT EXISTS idx_takedown_items_case ON takedown_items(case_id, status, due_at);

-- The active browser-storage worker never reads or writes the legacy content
-- tables above. Search reservations contain no query, URL, identity or IP.
CREATE TABLE IF NOT EXISTS private_usage_daily (
  day TEXT PRIMARY KEY,
  search_count INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0
);

-- Explicitly consented assistance requests are emailed to the team. When the
-- email is delivered only a content-free receipt remains (delivered = 1; empty
-- name/email/message). The full request is kept (delivered = 0) only when
-- email delivery is unavailable or fails. Every row is purged after 30 days.
-- Migration for an existing database (run once):
--   ALTER TABLE assistance_requests ADD COLUMN links_json TEXT;
--   ALTER TABLE assistance_requests ADD COLUMN delivered INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS assistance_requests (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  help_type TEXT NOT NULL,
  attachment_json TEXT,
  consent_version TEXT NOT NULL,
  links_json TEXT,
  delivered INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS assistance_requests_created ON assistance_requests (created_at);

-- Active auth/quota metadata exception: no raw IPs, queries, names or scan IDs.
-- Operator tokens are random, hashed, expire after eight hours and are revocable.
CREATE TABLE IF NOT EXISTS operator_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('admin', 'partner')),
  partner_email TEXT
);
CREATE INDEX IF NOT EXISTS idx_operator_sessions_expiry ON operator_sessions(expires_at);
CREATE TABLE IF NOT EXISTS operator_login_limits (
  day TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day, ip_hash, bucket)
);
CREATE TABLE IF NOT EXISTS search_permits (
  ticket_hash TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  owner_hash TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('public', 'operator')),
  provider TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  max_requests INTEGER NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_search_permit_quota ON search_permits(day, owner_hash, mode);
-- Thirty days of content-free estimates; never joined to assistance/content.
CREATE TABLE IF NOT EXISTS private_usage_summary (
  day TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('public', 'operator')),
  provider TEXT NOT NULL,
  scan_starts INTEGER NOT NULL DEFAULT 0,
  search_attempts INTEGER NOT NULL DEFAULT 0,
  search_successes INTEGER NOT NULL DEFAULT 0,
  search_failures INTEGER NOT NULL DEFAULT 0,
  estimated_search_cost_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY(day, mode, provider)
);
-- Permit issuance and scan-start accounting share one atomic SQLite statement.
-- Retrying a unique ticket never fires this trigger a second time.
CREATE TRIGGER IF NOT EXISTS count_search_permit_start
AFTER INSERT ON search_permits
BEGIN
  INSERT INTO private_usage_summary (day, mode, provider, scan_starts)
    VALUES (NEW.day, NEW.mode, NEW.provider, 1)
    ON CONFLICT(day, mode, provider)
    DO UPDATE SET scan_starts = scan_starts + 1;
END;

-- Opt-in AI drafting: daily counters and estimated cost only. Prompts, drafts,
-- result details and IP digests are never stored here. Purged after 30 days.
CREATE TABLE IF NOT EXISTS ai_draft_usage (
  day TEXT PRIMARY KEY,
  requests INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  in_tokens INTEGER NOT NULL DEFAULT 0,
  out_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0
);

-- Short-lived keyed abuse counters and query-free provider concurrency leases.
CREATE TABLE IF NOT EXISTS public_abuse_counters (
  owner_hash TEXT NOT NULL,
  scope TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(owner_hash, scope, bucket)
);
CREATE INDEX IF NOT EXISTS idx_public_abuse_expiry ON public_abuse_counters(expires_at);
CREATE TABLE IF NOT EXISTS relay_leases (
  id TEXT PRIMARY KEY,
  owner_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relay_lease_owner ON relay_leases(owner_hash, expires_at);

-- Optional email: encrypted short-lived credentials; never store draft content.
CREATE TABLE IF NOT EXISTS email_oauth (
  id TEXT PRIMARY KEY, binding TEXT NOT NULL, provider TEXT NOT NULL,
  sealed TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_oauth_expiry ON email_oauth(expires_at);
CREATE TABLE IF NOT EXISTS email_sessions (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, sealed TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_session_expiry ON email_sessions(expires_at);
CREATE TABLE IF NOT EXISTS email_sends (
  session_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  status TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(session_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_email_send_expiry ON email_sends(expires_at);

-- Explicitly approved follow-ups. Content is encrypted; terminal jobs erase it.
CREATE TABLE IF NOT EXISTS email_followups (
  session_id TEXT NOT NULL, request_id TEXT NOT NULL, sealed TEXT NOT NULL,
  status TEXT NOT NULL, first_sent_at INTEGER, due_at INTEGER,
  updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY(session_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_email_followup_due ON email_followups(status, due_at);
-- Keyed mailbox fingerprint allows recovery only after fresh provider login.
CREATE TABLE IF NOT EXISTS email_owners (
  session_id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_owner ON email_owners(owner_hash);

-- Partner organisations (NGOs, law and PR firms) sign in with a Cloudflare
-- Access email one-time PIN. Business contact details only; no case content.
CREATE TABLE IF NOT EXISTS partners (
  email TEXT PRIMARY KEY,
  organisation TEXT NOT NULL DEFAULT '',
  daily_limit INTEGER NOT NULL DEFAULT 50 CHECK(daily_limit BETWEEN 1 AND 500),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);
-- Daily scan starts per partner, kept for 30 days (no queries or names).
CREATE TABLE IF NOT EXISTS partner_usage (
  day TEXT NOT NULL,
  email TEXT NOT NULL,
  scans INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day, email)
);
