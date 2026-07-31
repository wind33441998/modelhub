// ModelHub License Server — License key generation
// Keys are stored in DB; verification uses lookup + HMAC integrity check

const crypto = require("crypto");
const HMAC_KEY = process.env.MODELHUB_HMAC_KEY || "dev-hmac-key-change-in-prod";

const TIERS = {
  trial:    { days: 7,    devices: 1,  label: "Trial" },
  monthly:  { days: 30,   devices: 3,  label: "Monthly" },
  yearly:   { days: 365,  devices: 5,  label: "Yearly" },
  lifetime: { days: 36500, devices: 10, label: "Lifetime" },
};

function randomHex(len) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString("hex").slice(0, len).toUpperCase();
}

// Generate MHUB-XXXX-XXXX-XXXX-XXXX
function generateLicense() {
  const raw = randomHex(16);
  const parts = raw.match(/.{1,4}/g).join("-");
  return "MHUB-" + parts;
}

// Create an integrity token (HMAC) from license key + email + tier + issuedAt.
// issuedAt MUST be supplied by the caller so signing and verification share the
// exact same timestamp; otherwise verifyIntegrity can never match (Bug #2).
function signLicense(license_key, email, tier, issuedAt) {
  const ts = issuedAt || Date.now();
  const payload = [license_key, email, tier, ts].join("|");
  return crypto.createHmac("sha256", HMAC_KEY).update(payload).digest("hex");
}

function verifyIntegrity(license_key, email, tier, issuedAt, signature) {
  const payload = [license_key, email, tier, issuedAt].join("|");
  const expected = crypto.createHmac("sha256", HMAC_KEY).update(payload).digest("hex");
  return signature === expected;
}

module.exports = { generateLicense, signLicense, verifyIntegrity, TIERS };
