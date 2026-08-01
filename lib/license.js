// ModelHub EXE — License verification module
// Manages license key entry, verification, caching, and feature gating

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const http = require("http");

const LICENSE_SERVER = process.env.MODELHUB_LICENSE_SERVER || "https://webhook.claude-proxys.com";
const LIC_CACHE = path.join(os.homedir(), ".modelhub", "license.json");
const LIC_KEY_FILE = path.join(os.homedir(), ".modelhub", "license.key");

// ─── Hardware ID ───
// Generate a stable device fingerprint (CPU + MAC + hostname)
function getHwId() {
  const parts = [];
  try {
    const interfaces = os.networkInterfaces();
    for (const [name, addrs] of Object.entries(interfaces)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        if (addr.mac && addr.mac !== "00:00:00:00:00:00") {
          parts.push(addr.mac); break;
        }
      }
      if (parts.length) break;
    }
  } catch (e) {}
  parts.push(os.hostname());
  parts.push(os.cpus()[0]?.model || "unknown");
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

// ─── License Key Management ───
function getSavedLicenseKey() {
  try { return fs.readFileSync(LIC_KEY_FILE, "utf-8").trim(); } catch (e) { return null; }
}

function saveLicenseKey(key) {
  try {
    fs.mkdirSync(path.dirname(LIC_KEY_FILE), { recursive: true });
    fs.writeFileSync(LIC_KEY_FILE, key.trim(), { mode: 0o600 });
  } catch (e) { console.error("[License] Failed to save license key:", e.message); }
}

// ─── Cache ───
function getCachedLicense() {
  try {
    const data = JSON.parse(fs.readFileSync(LIC_CACHE, "utf-8"));
    // Only a previously-VALID license may be honored offline (Bug #5).
    // 24h fresh cache, or 7-day offline grace from first successful verification.
    if (data.valid && data.cached_at && Date.now() - data.cached_at < 86400000) return data;
    if (data.valid && data.first_cached && Date.now() - data.first_cached < 7 * 86400000) return data;
    return null;
  } catch (e) { return null; }
}

function saveCachedLicense(data) {
  try {
    const cache = Object.assign({}, data, { cached_at: Date.now() });
    if (!cache.first_cached) cache.first_cached = Date.now();
    fs.mkdirSync(path.dirname(LIC_CACHE), { recursive: true });
    fs.writeFileSync(LIC_CACHE, JSON.stringify(cache, null, 2), { mode: 0o600 });
  } catch (e) { /* Silently fail cache write */ }
}

function clearCache() {
  try { fs.unlinkSync(LIC_CACHE); } catch (e) {}
  try { fs.unlinkSync(LIC_KEY_FILE); } catch (e) {}
}

// ─── Verification ───
function verifyWithServer(licenseKey, hwId) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ license_key: licenseKey, hw_id: hwId, device_name: os.hostname() });
    const u = new URL(LICENSE_SERVER + "/api/verify");
    const isHttps = u.protocol === "https:";
    const mod = isHttps ? require("https") : http;

    const options = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout: 5000,
    };

    const req = mod.request(options, (resp) => {
      let data = "";
      resp.on("data", (c) => (data += c));
      resp.on("end", () => {
        try {
          const j = JSON.parse(data);
          if (j.valid) {
            saveCachedLicense(j);
            resolve({ ok: true, data: j });
          } else {
            resolve({ ok: false, error: j.error || "License invalid" });
          }
        } catch (e) {
          resolve({ ok: false, error: "Invalid server response" });
        }
      });
    });

    req.on("error", (e) => resolve({ ok: false, error: e.message, offline: true }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "Server timeout", offline: true }); });
    req.write(body);
    req.end();
  });
}

// ─── Main Verification Flow ───
// Returns: { ok, licensed, tier, error?, device_count?, device_limit?, remaining_days? }
async function checkLicense() {
  const savedKey = getSavedLicenseKey();

  // No license key saved → check for trial or prompt user
  if (!savedKey) {
    const cache = getCachedLicense();
    if (cache && cache.valid) return { ok: true, licensed: true, cache: true, ...cache };
    return { ok: true, licensed: false, trial: true, error: "No license key. Enter key or use 7-day free trial." };
  }

  // Try online verification
  const hwId = getHwId();
  const result = await verifyWithServer(savedKey, hwId);

  if (result.ok) {
    return { ok: true, licensed: true, ...result.data };
  }

  // Offline: only a previously-valid key (filtered by getCachedLicense) is honored.
  if (result.offline) {
    const cache = getCachedLicense();
    if (cache && cache.valid) return { ok: true, licensed: true, offline: true, ...cache };
    return { ok: false, licensed: false, error: "Cannot verify license offline. Check internet or enter a valid key." };
  }

  // Server rejected the key
  return { ok: false, licensed: false, error: result.error };
}

// ─── Feature Gating ───
function getAllowedProviders(tier) {
  // Trial: only DeepSeek
  // Paid: all providers
  if (tier === "trial" || !tier) return ["deepseek"];
  return null; // null = all providers
}

function getAllowedModels(tier) {
  if (tier === "trial" || !tier) return ["deepseek-chat", "deepseek-reasoner"];
  return null;
}

function getMaxDevices(tier) {
  const map = { trial: 1, monthly: 3, yearly: 5, lifetime: 10 };
  return map[tier] || 1;
}

module.exports = {
  getHwId, checkLicense, saveLicenseKey, getSavedLicenseKey, clearCache,
  getAllowedProviders, getAllowedModels, getMaxDevices, LIC_KEY_FILE,
};

