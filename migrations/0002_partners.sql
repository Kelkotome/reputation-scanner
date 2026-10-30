-- 2026-10-05: partner email sign-in. Apply once to databases created before this date.
ALTER TABLE operator_sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('admin', 'partner'));
ALTER TABLE operator_sessions ADD COLUMN partner_email TEXT;
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
