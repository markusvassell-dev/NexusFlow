-- NexusFlow — PostgreSQL schema (single-file migration)
-- Apply with: npm run db:migrate  (or psql "$DATABASE_URL" -f db/schema.sql)

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- ---------- Enums ----------
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('admin', 'reviewer', 'editor');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE run_status AS ENUM (
    'triggered',        -- webhook accepted, generation queued
    'generating',       -- Replit generation in flight
    'seo_review',       -- gate 1: human review of draft (+ SEO score)
    'revision',         -- looped back to generation with reviewer note
    'deploying',        -- WordPress publish in flight
    'dist_generating',  -- GPT-4o distribution payloads in flight
    'dist_review',      -- gate 2: human review of ads/email/social payloads
    'publishing',       -- fan-out to meta-ads / activecampaign / social queues
    'completing',       -- Karbon timeline callback in flight
    'complete',
    'failed'            -- terminal: retries exhausted, "Workflow Failed" posted to Karbon
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE draft_status AS ENUM ('draft', 'approved', 'deployed', 'published');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- users ----------
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL,
  role          user_role NOT NULL DEFAULT 'reviewer',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sessions live primarily in Redis (sess:{jti} keys, TTL-bound). This table is the
-- durable audit copy so active logins survive a Redis flush and can be revoked in bulk.
CREATE TABLE IF NOT EXISTS sessions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(), -- = JWT jti
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent TEXT,
  ip         TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, expires_at DESC);

-- ---------- workflow_runs ----------
CREATE TABLE IF NOT EXISTS workflow_runs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  karbon_work_id   TEXT NOT NULL,
  karbon_stage_id  TEXT NOT NULL,
  client_name      TEXT NOT NULL DEFAULT '',
  topic            TEXT NOT NULL,
  keywords         TEXT[] NOT NULL DEFAULT '{}',
  tone             TEXT NOT NULL DEFAULT '',
  status           run_status NOT NULL DEFAULT 'triggered',
  current_step     TEXT NOT NULL DEFAULT 'trigger',
  seo_score        INTEGER,
  seo_report       JSONB,
  revision_count   INTEGER NOT NULL DEFAULT 0,
  approved_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  published_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  error            JSONB,          -- terminal failure detail {step, message, httpStatus, body}
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ,
  -- Idempotency backstop: Redis SETNX is the fast path; this constraint is the
  -- durable guarantee that one Karbon stage change == one workflow run.
  CONSTRAINT uq_karbon_trigger UNIQUE (karbon_work_id, karbon_stage_id)
);
CREATE INDEX IF NOT EXISTS idx_runs_status ON workflow_runs(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_created ON workflow_runs(created_at DESC);

-- ---------- content_drafts ----------
CREATE TABLE IF NOT EXISTS content_drafts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id       UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  blog_title            TEXT NOT NULL DEFAULT '',
  blog_meta_description TEXT NOT NULL DEFAULT '',
  blog_text             TEXT NOT NULL DEFAULT '',      -- full markdown from the Replit generator
  lead_magnet_url       TEXT,                          -- public PDF URL returned by the generator
  live_url              TEXT,                          -- WordPress URL after deploy
  meta_ads_payload      JSONB,  -- {headline, primaryText, link}
  ac_email_payload      JSONB,  -- {subject, body}
  social_payload        JSONB,  -- {linkedin, facebook, instagram}
  overrides             JSONB NOT NULL DEFAULT '{}',   -- {channel: {field: {by, at}}} manual-edit log
  status                draft_status NOT NULL DEFAULT 'draft',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_drafts_run ON content_drafts(workflow_run_id, created_at DESC);

-- ---------- audit_trails ----------
CREATE TABLE IF NOT EXISTS audit_trails (
  id              BIGSERIAL PRIMARY KEY,
  workflow_run_id UUID REFERENCES workflow_runs(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL, -- NULL = system/api actor
  actor           TEXT NOT NULL DEFAULT 'system',               -- 'system' | 'api' | user handle
  action          TEXT NOT NULL,                                -- e.g. 'draft.approved', 'job.failed'
  payload         JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_run  ON audit_trails(workflow_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_trails(user_id, created_at DESC);

-- ---------- connected_accounts (OAuth/API credentials, encrypted at rest) ----------
CREATE TABLE IF NOT EXISTS connected_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider        TEXT NOT NULL UNIQUE, -- 'karbon'|'replit'|'openai'|'wordpress'|'meta'|'activecampaign'|'linkedin'|'facebook'|'instagram'
  encrypted_token TEXT NOT NULL,        -- AES-256-GCM: iv.tag.ciphertext (base64), key from MASTER_ENCRYPTION_KEY
  scopes          TEXT[] NOT NULL DEFAULT '{}',
  meta            JSONB NOT NULL DEFAULT '{}',
  verified_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- app_settings (workflow gates, adapter toggles, brand voice) ----------
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO app_settings (key, value) VALUES
  ('seo_auto_approve_threshold', '80'),
  ('auto_approve_enabled', 'false'),
  ('adapters_enabled', '{"ads": true, "email": true, "social": true}'),
  ('brand_voice', '"Write for owner-managers of health & safety businesses. Lead with financial mechanics — figures, thresholds, deadlines. Plain UK English. No hype, no filler, no exclamation marks."')
ON CONFLICT (key) DO NOTHING;

-- Seed users (bcrypt hash of 'change-me' — rotate immediately):
-- $2a$10$8K1p/a0dL1LXMIgoEDFrwOfMQmGCoOqZQu9pF7DjS4NxWlyy0jz2W
INSERT INTO users (email, password_hash, first_name, last_name, role) VALUES
  ('jmercer@aegisadvisory.co.uk', '$2a$10$8K1p/a0dL1LXMIgoEDFrwOfMQmGCoOqZQu9pF7DjS4NxWlyy0jz2W', 'Jude',   'Mercer', 'admin'),
  ('dokafor@aegisadvisory.co.uk', '$2a$10$8K1p/a0dL1LXMIgoEDFrwOfMQmGCoOqZQu9pF7DjS4NxWlyy0jz2W', 'Dana',   'Okafor', 'reviewer'),
  ('mreyes@aegisadvisory.co.uk',  '$2a$10$8K1p/a0dL1LXMIgoEDFrwOfMQmGCoOqZQu9pF7DjS4NxWlyy0jz2W', 'Marcus', 'Reyes',  'editor')
ON CONFLICT (email) DO NOTHING;
