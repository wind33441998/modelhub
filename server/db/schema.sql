-- ModelHub License Server — Supabase Database Schema
-- Run this in Supabase SQL Editor to create tables

-- Licenses table
CREATE TABLE IF NOT EXISTS licenses (
  id BIGSERIAL PRIMARY KEY,
  license_key TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('trial', 'monthly', 'yearly', 'lifetime')),
  issued_at BIGINT NOT NULL,
  gumroad_transaction_id TEXT DEFAULT '',
  referred_by TEXT DEFAULT '',
  referral_discount_applied BOOLEAN DEFAULT FALSE,
  referral_extra_days INTEGER DEFAULT 0,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_licenses_key ON licenses(license_key);
CREATE INDEX IF NOT EXISTS idx_licenses_email ON licenses(email);

-- Devices table
CREATE TABLE IF NOT EXISTS devices (
  id BIGSERIAL PRIMARY KEY,
  license_key TEXT NOT NULL REFERENCES licenses(license_key),
  hw_id TEXT NOT NULL,
  name TEXT DEFAULT '',
  registered_at BIGINT NOT NULL,
  last_seen BIGINT NOT NULL,
  UNIQUE(license_key, hw_id)
);

CREATE INDEX IF NOT EXISTS idx_devices_license ON devices(license_key);

-- Referrals table
CREATE TABLE IF NOT EXISTS referrals (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  owner_email TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  uses INTEGER DEFAULT 0,
  reward_days_given INTEGER DEFAULT 0,
  last_used BIGINT,
  referee_email TEXT,
  referee_tier TEXT
);

CREATE INDEX IF NOT EXISTS idx_referrals_code ON referrals(code);

-- Row Level Security (for Supabase public access)
ALTER TABLE licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;

-- Allow all operations for service_role (API key)
CREATE POLICY "service_role_all" ON licenses FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON devices FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON referrals FOR ALL USING (true) WITH CHECK (true);
