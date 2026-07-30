// License issuance + storage abstraction for ModelHub.
// Mirrors api/license.js store (Supabase if configured, else local JSON in api/tmp).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let _supabase = null;
function getDb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!_supabase && url && key) {
    try { _supabase = require("@supabase/supabase-js").createClient(url, key); } catch (e) { _supabase = null; }
  }
  return _supabase;
}

const DATA_DIR = process.env.MODELHUB_DATA_DIR || path.join(__dirname, "..", "tmp");
function readStore(n) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, n + ".json"), "utf-8")); } catch (e) { return []; }
}
function writeStore(n, d) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, n + ".json"), JSON.stringify(d, null, 2));
}

const TIERS = {
  trial:    { days: 7,     devices: 1,  label: "Trial" },
  monthly:  { days: 30,    devices: 3,  label: "Monthly" },
  yearly:   { days: 365,   devices: 5,  label: "Yearly" },
  lifetime: { days: 36500, devices: 10, label: "Lifetime" },
};

const REF_REWARDS = { monthly: 7, yearly: 60, lifetime: 180 };

const store = {
  findLicense: async (key) => {
    if (getDb()) { const { data } = await getDb().from("licenses").select("*").eq("license_key", key).single(); return data || null; }
    return readStore("licenses").find((l) => l.license_key === key) || null;
  },
  // Idempotency: a PayPal capture id must map to at most one license.
  findCapture: async (captureId) => {
    if (!captureId) return null;
    if (getDb()) { const { data } = await getDb().from("licenses").select("*").eq("paypal_capture_id", captureId).single(); return data || null; }
    return readStore("licenses").find((l) => l.paypal_capture_id === captureId) || null;
  },
  addLicense: async (lic) => {
    if (getDb()) { const { error } = await getDb().from("licenses").insert(lic); return !error; }
    const l = readStore("licenses"); l.push(lic); writeStore("licenses", l); return true;
  },
  getReferral: async (code) => {
    if (getDb()) { const { data } = await getDb().from("referrals").select("*").eq("code", code).single(); return data || null; }
    return readStore("referrals").find((r) => r.code === code) || null;
  },
  updateReferral: async (code, updates) => {
    if (getDb()) { await getDb().from("referrals").update(updates).eq("code", code); }
    else {
      const l = readStore("referrals");
      const i = l.findIndex((r) => r.code === code);
      if (i >= 0) { l[i] = { ...l[i], ...updates }; writeStore("referrals", l); }
    }
  },
};

function genLicenseKey() {
  return "MHUB-" + crypto.randomBytes(8).toString("hex").toUpperCase().match(/.{1,4}/g).join("-");
}

// Apply referral reward (if valid code + paid tier). Returns extra days granted.
async function applyReferral(refCode, refereeEmail, tier) {
  if (!refCode) return 0;
  const ref = await store.getReferral(refCode);
  if (!ref) return 0;
  const days = REF_REWARDS[tier] || 0;
  if (!days) return 0;
  const uses = (ref.uses || 0) + 1;
  const reward_days_given = (ref.reward_days_given || 0) + days;
  await store.updateReferral(refCode, {
    uses, reward_days_given, last_used: Date.now(),
    referee_email: refereeEmail, referee_tier: tier,
  });
  return days;
}

// Issue a license after a successful payment.
async function issueLicense({ email, tier, ref, provider, captureId }) {
  if (!email || !TIERS[tier]) throw new Error("invalid email or tier");
  const referral_extra_days = await applyReferral(ref, email, tier);
  const license_key = genLicenseKey();
  const lic = {
    license_key, email, tier,
    issued_at: Date.now(),
    referral_extra_days,
    referred_by: ref || "",
    referral_discount_applied: !!ref,
    active: true,
    provider: provider || "paypal",
    paypal_capture_id: captureId || "",
  };
  await store.addLicense(lic);
  const t = TIERS[tier];
  return {
    license_key, email, tier, label: t.label,
    days: t.days + referral_extra_days,
    devices: t.devices,
    referral_extra_days,
  };
}

module.exports = { TIERS, REF_REWARDS, store, genLicenseKey, applyReferral, issueLicense };
