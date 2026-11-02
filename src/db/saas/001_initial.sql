CREATE TABLE IF NOT EXISTS saas_users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'USER' CHECK (role IN ('USER', 'ADMIN')),
  email_verified_at TIMESTAMPTZ,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  disabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (email_normalized = lower(email_normalized)),
  CHECK (role = 'USER' OR email_normalized = 'himanshusoni7899@gmail.com')
);

CREATE UNIQUE INDEX IF NOT EXISTS saas_one_admin
  ON saas_users (role) WHERE role = 'ADMIN';

CREATE TABLE IF NOT EXISTS saas_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES saas_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS saas_sessions_user_expiry
  ON saas_sessions (user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS saas_email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES saas_users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('VERIFY_EMAIL', 'RESET_PASSWORD')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS saas_auth_rate_limits (
  bucket_hash TEXT PRIMARY KEY,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  window_started_at TIMESTAMPTZ NOT NULL,
  blocked_until TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS saas_bootstrap_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  admin_user_id UUID REFERENCES saas_users(id),
  admin_bootstrap_completed_at TIMESTAMPTZ,
  payment_launch_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO saas_bootstrap_state (singleton, payment_launch_at)
VALUES (TRUE, TIMESTAMPTZ '2026-11-02 12:00:00+00')
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS saas_user_leads (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES saas_users(id) ON DELETE CASCADE,
  canonical_key TEXT NOT NULL,
  source TEXT NOT NULL,
  payload JSONB NOT NULL,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (user_id, canonical_key)
);

CREATE INDEX IF NOT EXISTS saas_user_leads_owner_saved
  ON saas_user_leads (user_id, saved_at DESC);

CREATE TABLE IF NOT EXISTS saas_lead_usage (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES saas_users(id) ON DELETE CASCADE,
  user_lead_id UUID NOT NULL REFERENCES saas_user_leads(id) ON DELETE CASCADE,
  canonical_key TEXT NOT NULL,
  source TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (user_id, canonical_key)
);

CREATE TABLE IF NOT EXISTS saas_entitlements (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES saas_users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('PAID_LIFETIME', 'MANUAL_LIFETIME')),
  source TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES saas_users(id),
  revocation_reason TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS saas_one_active_lifetime_entitlement
  ON saas_entitlements (user_id, kind)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS saas_payment_orders (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES saas_users(id),
  provider TEXT NOT NULL,
  provider_order_id TEXT UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL CHECK (currency = 'INR'),
  status TEXT NOT NULL CHECK (status IN ('CREATED', 'PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'REFUNDED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS saas_payment_orders_user_created
  ON saas_payment_orders (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS saas_payment_transactions (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES saas_payment_orders(id),
  provider_payment_id TEXT NOT NULL UNIQUE,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL CHECK (currency = 'INR'),
  status TEXT NOT NULL,
  provider_created_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  raw_event JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS saas_refunds (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES saas_payment_orders(id),
  provider_refund_id TEXT UNIQUE,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'SUCCESS', 'FAILED')),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  confirmed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS saas_webhook_events (
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  processed_at TIMESTAMPTZ,
  payload_hash TEXT NOT NULL,
  PRIMARY KEY (provider, provider_event_id)
);

CREATE TABLE IF NOT EXISTS saas_package_prices (
  id UUID PRIMARY KEY,
  price_minor INTEGER NOT NULL CHECK (price_minor > 0),
  currency CHAR(3) NOT NULL CHECK (currency = 'INR'),
  effective_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  changed_by UUID REFERENCES saas_users(id),
  change_reason TEXT
);

CREATE TABLE IF NOT EXISTS saas_admin_audit (
  id UUID PRIMARY KEY,
  admin_user_id UUID NOT NULL REFERENCES saas_users(id),
  admin_email TEXT NOT NULL,
  target_user_id UUID REFERENCES saas_users(id),
  action TEXT NOT NULL,
  previous_value JSONB,
  new_value JSONB,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION saas_reject_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'saas_admin_audit is append-only';
END;
$$;

DROP TRIGGER IF EXISTS saas_admin_audit_immutable ON saas_admin_audit;
CREATE TRIGGER saas_admin_audit_immutable
  BEFORE UPDATE OR DELETE ON saas_admin_audit
  FOR EACH ROW EXECUTE FUNCTION saas_reject_audit_mutation();
