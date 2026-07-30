// ModelHub License Server — Vercel Serverless Handler
// Uses Supabase (free PostgreSQL) for persistent storage

// Supabase connection (set in Vercel env vars). Lazily required so the function
// still loads when @supabase/supabase-js is absent (falls back to local JSON).
let supabase = null;
function getDb() {
  if (!supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (url && key) {
      try {
        const { createClient } = require("@supabase/supabase-js");
        supabase = createClient(url, key);
      } catch (e) { supabase = null; }
    }
  }
  return supabase;
}

// ─── Fallback: JSON file storage (for local dev only) ───
const fs = require("fs");
const path = require("path");
const DATA_DIR = path.join(__dirname, "..", "tmp");

function readStore(name) {
  const f = path.join(DATA_DIR, name + ".json");
  try { return JSON.parse(fs.readFileSync(f, "utf-8")); } catch (e) { return []; }
}
function writeStore(name, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, name + ".json"), JSON.stringify(data, null, 2));
}

// ─── Storage abstraction ───
const store = {
  async findLicense(key) {
    if (getDb()) {
      const { data } = await getDb().from("licenses").select("*").eq("license_key", key).single();
      return data || null;
    }
    return readStore("licenses").find((l) => l.license_key === key) || null;
  },
  async addLicense(license) {
    if (getDb()) {
      const { error } = await getDb().from("licenses").insert(license);
      return !error;
    }
    const list = readStore("licenses");
    list.push(license);
    writeStore("licenses", list);
    return true;
  },
  async updateLicense(key, updates) {
    if (getDb()) {
      const { error } = await getDb().from("licenses").update(updates).eq("license_key", key);
      return !error;
    }
    const list = readStore("licenses");
    const idx = list.findIndex((l) => l.license_key === key);
    if (idx === -1) return false;
    list[idx] = { ...list[idx], ...updates };
    writeStore("licenses", list);
    return true;
  },
  async countDevices(key) {
    if (getDb()) {
      const { count } = await getDb().from("devices").select("*", { count: "exact", head: true }).eq("license_key", key);
      return count || 0;
    }
    return readStore("devices").filter((d) => d.license_key === key).length;
  },
  async registerDevice(license_key, hw_id, name) {
    if (getDb()) {
      const { data } = await getDb().from("devices").select("*").eq("license_key", license_key).eq("hw_id", hw_id).single();
      if (data) {
        await getDb().from("devices").update({ last_seen: Date.now() }).eq("id", data.id);
        return data;
      }
      await getDb().from("devices").insert({ license_key, hw_id, name: name || "Unknown", registered_at: Date.now(), last_seen: Date.now() });
    } else {
      const list = readStore("devices");
      const existing = list.find((d) => d.license_key === license_key && d.hw_id === hw_id);
      if (existing) { existing.last_seen = Date.now(); writeStore("devices", list); return existing; }
      list.push({ license_key, hw_id, name: name || "Unknown", registered_at: Date.now(), last_seen: Date.now() });
      writeStore("devices", list);
    }
    return { license_key, hw_id };
  },
  async getReferral(code) {
    if (getDb()) {
      const { data } = await getDb().from("referrals").select("*").eq("code", code).single();
      return data || null;
    }
    return readStore("referrals").find((r) => r.code === code) || null;
  },
  async createReferral(ref) {
    if (getDb()) {
      const { error } = await getDb().from("referrals").insert(ref);
      return !error;
    }
    const list = readStore("referrals");
    list.push(ref);
    writeStore("referrals", list);
    return true;
  },
  async updateReferral(code, updates) {
    if (getDb()) {
      await getDb().from("referrals").update(updates).eq("code", code);
    } else {
      const list = readStore("referrals");
      const idx = list.findIndex((r) => r.code === code);
      if (idx >= 0) { list[idx] = { ...list[idx], ...updates }; writeStore("referrals", list); }
    }
  },
};

// ─── Crypto ───
const crypto = require("crypto");
const HMAC_KEY = process.env.MODELHUB_HMAC_KEY || "dev-hmac-key-must-change-in-prod";

function genLicenseKey() {
  const raw = crypto.randomBytes(8).toString("hex").toUpperCase();
  return "MHUB-" + raw.match(/.{1,4}/g).join("-");
}

const TIERS = { trial: { days: 7, devices: 1 }, monthly: { days: 30, devices: 3 }, yearly: { days: 365, devices: 5 }, lifetime: { days: 36500, devices: 10 } };

// ─── JSON responses ───
function json(res, code, data) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.statusCode = code;
  res.end(JSON.stringify(data));
}

function getExpiry(lic) {
  const t = TIERS[lic.tier];
  if (!t) return 0;
  return lic.issued_at + t.days * 86400000 + (lic.referral_extra_days || 0) * 86400000;
}

// ─── Handlers ───
async function handleVerify(body) {
  if (!body.license_key) return { status: 400, data: { valid: false, error: "license_key required" } };
  const dbLic = await store.findLicense(body.license_key);
  if (!dbLic || dbLic.active === false) return { status: 200, data: { valid: false, error: "License not found or deactivated" } };
  const expiresAt = getExpiry(dbLic);
  if (Date.now() >= expiresAt) return { status: 200, data: { valid: false, error: "License expired" } };
  const t = TIERS[dbLic.tier];
  if (body.hw_id) {
    const devCount = await store.countDevices(body.license_key);
    const existing = false; // simplified for now
    if (devCount >= t.devices) {
      // Check if this HW ID is already registered
      return { status: 200, data: { valid: true, warning: "Device limit reached (" + t.devices + ")" } };
    }
    await store.registerDevice(body.license_key, body.hw_id, body.device_name || "");
  }
  return { status: 200, data: { valid: true, email: dbLic.email, tier: dbLic.tier, label: t.label, remaining_days: Math.max(0, Math.floor((expiresAt - Date.now()) / 86400000)), devices: t.devices, device_count: await store.countDevices(body.license_key) }};
}

// ─── Main handler ───
module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  try {
    if (path === "/api/health" && req.method === "GET") return json(res, 200, { ok: true, mode: supabaseUrl ? "supabase" : "local-json" });
    if (path === "/api/verify" && req.method === "POST") {
      const body = JSON.parse(req.body || "{}");
      const r = await handleVerify(body);
      return json(res, r.status, r.data);
    }
    if (path === "/api/register" && req.method === "POST") {
      const body = JSON.parse(req.body || "{}");
      if (!body.email || !TIERS[body.tier]) return json(res, 400, { ok: false, error: "email and valid tier required" });
      const lk = genLicenseKey();
      await store.addLicense({ license_key: lk, email: body.email, tier: body.tier, issued_at: Date.now(), referral_extra_days: 0, active: true });
      return json(res, 200, { ok: true, license_key: lk });
    }
    json(res, 404, { error: "Not found" });
  } catch (e) {
    console.error("API Error:", e);
    json(res, 500, { error: "Internal error" });
  }
};
