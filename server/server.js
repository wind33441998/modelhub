// ModelHub License Server — Main API

const http = require("http");
const { generateLicense, signLicense, verifyIntegrity, TIERS } = require("./lib/crypto");
const store = require("./lib/store");
const { handleGumroadWebhook } = require("./webhook");

const PORT = process.env.PORT || 3001;

function json(res, code, data) {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = {};
      if (raw) {
        const ct = (req.headers["content-type"] || "").toLowerCase();
        try {
          if (ct.includes("application/json")) body = JSON.parse(raw);
          else if (ct.includes("application/x-www-form-urlencoded")) body = Object.fromEntries(new URLSearchParams(raw));
          else { try { body = JSON.parse(raw); } catch (e) { body = Object.fromEntries(new URLSearchParams(raw)); } }
        } catch (e) { body = {}; }
      }
      resolve({ raw, body });
    });
  });
}

function getExpiry(license) {
  const t = TIERS[license.tier];
  if (!t) return 0;
  const baseExpiry = license.issued_at + t.days * 86400000;
  const extra = (license.referral_extra_days || 0) * 86400000;
  return baseExpiry + extra;
}

// ─── POST /api/verify ───
async function handleVerify(req, res) {
  const { body } = await readBody(req);
  const { license_key, hw_id, device_name } = body;
  if (!license_key) return json(res, 400, { valid: false, error: "license_key required" });

  const dbLic = store.findLicense(license_key);
  if (!dbLic || !dbLic.active) return json(res, 200, { valid: false, error: "License key not found or deactivated" });

  // Integrity check (Bug #2): reject tampered records. Records issued before
  // the integrity field existed have no `integrity` → skip (backward compat).
  if (dbLic.integrity) {
    const ok = verifyIntegrity(dbLic.license_key, dbLic.email, dbLic.tier, dbLic.issued_at, dbLic.integrity);
    if (!ok) return json(res, 200, { valid: false, error: "License integrity check failed" });
  }

  const expiresAt = getExpiry(dbLic);
  const now = Date.now();
  if (now >= expiresAt) return json(res, 200, { valid: false, error: "License expired" });

  const t = TIERS[dbLic.tier];
  // Register device if hw_id provided
  if (hw_id) {
    const devCount = store.countDevices(license_key);
    const existing = store.getDevices().find((d) => d.license_key === license_key && d.hw_id === hw_id);
    if (!existing && devCount >= t.devices) {
      return json(res, 200, { valid: false, error: "Device limit reached (" + t.devices + ")", device_limit: t.devices, device_count: devCount });
    }
    store.registerDevice(license_key, hw_id, device_name || "");
  }

  json(res, 200, {
    valid: true,
    email: dbLic.email,
    tier: dbLic.tier,
    label: t.label,
    issued_at: dbLic.issued_at,
    expires_at: expiresAt,
    remaining_days: Math.max(0, Math.floor((expiresAt - now) / 86400000)),
    devices: t.devices,
    device_count: store.countDevices(license_key),
    device_limit: t.devices,
  });
}

// ─── POST /api/register ───
async function handleRegister(req, res) {
  const { body } = await readBody(req);
  const { email, tier, gumroad_transaction_id } = body;
  if (!email || !TIERS[tier]) return json(res, 400, { ok: false, error: "email and valid tier required" });

  const existing = store.getLicenses().find((l) => l.email === email && l.tier === tier);
  if (existing) return json(res, 200, { ok: true, license_key: existing.license_key, note: "Already registered" });

  const license_key = generateLicense();
  const issuedAt = Date.now();
  const integrity = signLicense(license_key, email, tier, issuedAt);
  store.addLicense({
    license_key, email, tier,
    issued_at: issuedAt,
    integrity,
    gumroad_transaction_id: gumroad_transaction_id || "",
    referral_extra_days: 0,
    active: true,
  });
  json(res, 200, { ok: true, license_key });
}

// ─── POST /api/referral/generate ───
async function handleReferralGenerate(req, res) {
  const { body } = await readBody(req);
  if (!body.email) return json(res, 400, { ok: false, error: "email required" });
  const code = store.generateReferralCode(body.email);
  json(res, 200, { ok: true, code });
}

// ─── POST /api/referral/apply ───
// SECURITY: apply ONLY records intent. It issues NO license and NO reward.
// The reward is granted only after a REAL payment, inside handleGumroadWebhook.
async function handleReferralApply(req, res) {
  const { body } = await readBody(req);
  const { code, referee_email } = body;
  if (!code || !referee_email) return json(res, 400, { ok: false, error: "code and referee_email required" });

  const ref = store.getReferrals().find((r) => r.code === code);
  if (!ref) return json(res, 404, { ok: false, error: "Invalid referral code" });

  // Anti-fraud guard 1: no self-referral
  if (ref.owner_email && ref.owner_email.toLowerCase() === String(referee_email).toLowerCase())
    return json(res, 400, { ok: false, error: "Cannot apply your own referral code" });

  // Within usage cap
  if ((ref.uses || 0) >= (ref.max_uses || 100))
    return json(res, 400, { ok: false, error: "Referral code has reached its usage limit" });

  // Record intent only — reward is issued after real payment via webhook
  store.addPendingReferral(code, referee_email);
  json(res, 200, { ok: true, message: "Referral code applied. Complete your purchase to activate the reward." });
}

// ─── POST /api/webhook/gumroad ───
// 实现已统一收归 ./webhook.js（单一权威实现），此处仅挂载路由。

// ─── GET /api/license/:key ───
async function handleLicenseInfo(req, res, urlParts) {
  const key = decodeURIComponent(urlParts.slice(3).join("/"));
  if (!key) return json(res, 400, { ok: false, error: "license key required" });
  const dbLic = store.findLicense(key);
  if (!dbLic) return json(res, 404, { ok: false, error: "License not found" });
  const t = TIERS[dbLic.tier];
  json(res, 200, {
    email: dbLic.email, tier: dbLic.tier, label: t ? t.label : "Unknown",
    issued_at: dbLic.issued_at, expires_at: getExpiry(dbLic),
    devices: t ? t.devices : 0, device_count: store.countDevices(key),
    referral_extra_days: dbLic.referral_extra_days || 0,
  });
}

// ─── Router ───
async function handleRequest(req, res) {
  if (req.method === "OPTIONS") return json(res, 204, {});
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  const method = req.method;
  try {
    if (method === "POST" && path === "/api/verify") return await handleVerify(req, res);
    if (method === "POST" && path === "/api/register") return await handleRegister(req, res);
    if (method === "POST" && path === "/api/referral/generate") return await handleReferralGenerate(req, res);
    if (method === "POST" && path === "/api/referral/apply") return await handleReferralApply(req, res);
    if (method === "POST" && path === "/api/webhook/gumroad") return await handleGumroadWebhook(req, res);
    if (method === "GET" && path.startsWith("/api/license/")) return await handleLicenseInfo(req, res, path.split("/"));
    if (method === "GET" && path === "/api/health") return json(res, 200, { ok: true, uptime: process.uptime() });
    json(res, 404, { error: "Not found" });
  } catch (e) { console.error("API Error:", e); json(res, 500, { error: "Internal error" }); }
}

const server = http.createServer(handleRequest);
server.listen(PORT, "127.0.0.1", () => {
  console.log("ModelHub License Server running on http://127.0.0.1:" + PORT);
  console.log("Endpoints: verify register referral referral webhook license health");
});

module.exports = (req, res) => handleRequest(req, res);

