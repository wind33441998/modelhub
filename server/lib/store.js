// ModelHub License Server — JSON file storage (MVP)

const fs = require("fs");
const path = require("path");
const DATA_DIR = process.env.MODELHUB_DATA_DIR || path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function dbFile(name) { return path.join(DATA_DIR, name + ".json"); }
function readStore(name) { try { return JSON.parse(fs.readFileSync(dbFile(name), "utf-8")); } catch (e) { return []; } }
function writeStore(name, data) { fs.writeFileSync(dbFile(name), JSON.stringify(data, null, 2)); }

// ─── Licenses ───
function getLicenses() { return readStore("licenses"); }
function saveLicenses(d) { writeStore("licenses", d); }

function findLicense(key) { return getLicenses().find((l) => l.license_key === key); }
function addLicense(license) { const list = getLicenses(); list.push(license); saveLicenses(list); return license; }

function updateLicense(key, updates) {
  const list = getLicenses();
  const idx = list.findIndex((l) => l.license_key === key);
  if (idx === -1) return null;
  list[idx] = { ...list[idx], ...updates };
  saveLicenses(list);
  return list[idx];
}

// ─── Devices ───
function getDevices() { return readStore("devices"); }
function saveDevices(d) { writeStore("devices", d); }

function registerDevice(license_key, hw_id, name) {
  const list = getDevices();
  const existing = list.find((d) => d.license_key === license_key && d.hw_id === hw_id);
  if (existing) { existing.last_seen = Date.now(); saveDevices(list); return existing; }
  const dev = { license_key, hw_id, name: name || "Unknown", registered_at: Date.now(), last_seen: Date.now() };
  list.push(dev); saveDevices(list); return dev;
}

function countDevices(license_key) { return getDevices().filter((d) => d.license_key === license_key).length; }

// ─── Referrals ───
const MAX_REFERRAL_USES = 100;
const REFERRAL_REWARD_DAYS = { monthly: 7, yearly: 60, lifetime: 180 };

function getReferrals() { return readStore("referrals"); }
function saveReferrals(d) { writeStore("referrals", d); }

function generateReferralCode(owner_email) {
  const list = getReferrals();
  const code = "REF" + Math.random().toString(36).slice(2, 8).toUpperCase();
  list.push({ code, owner_email, created_at: Date.now(), uses: 0, reward_days_given: 0, rewarded_referees: [], max_uses: MAX_REFERRAL_USES });
  saveReferrals(list); return code;
}

// Pending association: referee intends to use a code (recorded pre-purchase, NO reward yet)
function getPendingReferrals() { return readStore("referral_pending"); }
function savePendingReferrals(d) { writeStore("referral_pending", d); }
function addPendingReferral(code, referee_email) {
  const list = getPendingReferrals();
  const existing = list.find((p) => p.referee_email === referee_email);
  if (existing) { existing.code = code; existing.updated_at = Date.now(); }
  else list.push({ code, referee_email, created_at: Date.now() });
  savePendingReferrals(list);
}
function getPendingReferralByEmail(email) {
  const p = getPendingReferrals().find((x) => x.referee_email === email);
  return p ? p.code : null;
}
function removePendingReferral(email) {
  const list = getPendingReferrals().filter((x) => x.referee_email !== email);
  savePendingReferrals(list);
}

// Award referrer AFTER a REAL payment. Enforces four anti-fraud guards:
// 1) no self-referral  2) referee first-order dedup  3) per-code usage cap  4) rate limit
const _awardRate = {}; // code -> [timestamps] (in-memory rate limit)
function awardReferral(code, buyer_email, tier) {
  const list = getReferrals();
  const ref = list.find((r) => r.code === code);
  if (!ref) return { awarded: false, reason: "invalid_code" };
  const buyer = String(buyer_email).toLowerCase();
  if (ref.owner_email && ref.owner_email.toLowerCase() === buyer) return { awarded: false, reason: "self_referral" };
  if ((ref.uses || 0) >= (ref.max_uses || MAX_REFERRAL_USES)) return { awarded: false, reason: "code_exhausted" };
  if ((ref.rewarded_referees || []).includes(buyer)) return { awarded: false, reason: "already_rewarded" };
  const now = Date.now();
  const window = 10 * 60 * 1000;
  _awardRate[code] = (_awardRate[code] || []).filter((t) => now - t < window);
  if (_awardRate[code].length >= 5) return { awarded: false, reason: "rate_limited" };
  _awardRate[code].push(now);
  const rewardDays = REFERRAL_REWARD_DAYS[tier] || 0;
  if (rewardDays === 0) return { awarded: false, reason: "no_reward_for_tier" };
  const refLicense = getLicenses().find((l) => l.email === ref.owner_email);
  if (refLicense) {
    updateLicense(refLicense.license_key, { referral_extra_days: (refLicense.referral_extra_days || 0) + rewardDays });
  }
  ref.uses = (ref.uses || 0) + 1;
  ref.reward_days_given = (ref.reward_days_given || 0) + rewardDays;
  ref.last_used = now;
  ref.rewarded_referees = ref.rewarded_referees || [];
  ref.rewarded_referees.push(buyer);
  saveReferrals(list);
  return { awarded: true, reward_days: rewardDays, owner_email: ref.owner_email };
}

module.exports = {
  getLicenses, saveLicenses, findLicense, addLicense, updateLicense,
  getDevices, saveDevices, registerDevice, countDevices,
  getReferrals, saveReferrals, generateReferralCode,
  getPendingReferrals, savePendingReferrals, addPendingReferral, getPendingReferralByEmail, removePendingReferral,
  awardReferral,
};
