// ModelHub Gumroad Webhook — 单一权威实现 (single source of truth)
//
// 职责：Gumroad 付款通知 → 自动发放 License Key。
// 同时被 server/server.js 挂载（路由 /api/webhook/gumroad）以及可被 `node server/webhook.js`
// 直接以独立测试服务运行（:3002）。业务逻辑只有这一份，避免与 server.js 内联副本漂移。
//
// 安全：校验 Gumroad 签名 (X-Gumroad-Signature = HMAC-SHA256 over RAW body)。
//   - dev 模式（GUMROAD_SECRET 未设或为默认值）：不强制验签，仅告警（便于本地联调）。
//   - 生产模式（配置了真实密钥）：缺签名头或签名不匹配 → 一律 401 拒绝（不再"跳过"）。

const crypto = require("crypto");
const GUMROAD_SECRET = process.env.GUMROAD_SECRET || "dev-gumroad-secret";

// 与主授权服务复用同一套存储 + 签名逻辑，保证行为一致
const store = require("./lib/store");
const { signLicense, generateLicense } = require("./lib/crypto");

// Gumroad product_permalink → 内部 tier 映射
const PERMALINK_MAP = {
  "modelhub-trial": "trial",
  "modelhub-monthly": "monthly",
  "modelhub-yearly": "yearly",
  "modelhub-lifetime": "lifetime",
};

// 读取原始请求体（用于验签）。同时兼容被 server.js 引入与独立运行两种场景。
function readRawBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(raw));
  });
}

function parseBody(raw, headers) {
  if (!raw) return {};
  const ct = String(headers["content-type"] || "").toLowerCase();
  const tryForm = () => { try { return Object.fromEntries(new URLSearchParams(raw)); } catch (e) { return null; } };
  const tryJson = () => { try { return JSON.parse(raw); } catch (e) { return null; } };
  if (ct.includes("application/json")) return tryJson() || {};
  if (ct.includes("application/x-www-form-urlencoded")) return tryForm() || {};
  return tryJson() || tryForm() || {};
}

// 校验 Gumroad HMAC 签名。
// 返回：true(合法) | false(非法，应拒绝) | null(dev 模式，不强制)。
function verifyGumroad(rawBody, signature, secret) {
  if (!secret || secret === "dev-gumroad-secret") return null; // dev：不强制
  if (!signature) return false; // 生产：缺签名头 → 拒绝
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return signature === expected;
}

function sendJson(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(obj));
}

// 核心处理：验签 → 解析 → 幂等发放 → 推荐发奖。幂等：同 email+tier 不重复发证。
async function handleGumroadWebhook(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Method not allowed" });

  const raw = await readRawBody(req);
  const body = parseBody(raw, req.headers);
  const sig = req.headers["x-gumroad-signature"] || req.headers["X-Gumroad-Signature"];

  const sigOk = verifyGumroad(raw, sig, GUMROAD_SECRET);
  if (sigOk === false) return sendJson(res, 401, { ok: false, error: "Invalid signature" });
  if (sigOk === null) {
    console.warn("[Webhook] dev mode: Gumroad signature verification skipped (set GUMROAD_SECRET in production)");
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const permalink = body.product_permalink || body.permalink || "";
  const tierKey = String(permalink).split("/").filter(Boolean).pop() || "";
  const tier = PERMALINK_MAP[tierKey] || "monthly";

  if (!email) return sendJson(res, 400, { ok: false, error: "Missing email in webhook payload" });

  // 幂等：同 email+tier 已存在则直接返回，避免重复发证
  const existing = store.getLicenses().find((l) => l.email === email && l.tier === tier);
  if (existing) return sendJson(res, 200, { ok: true, license_key: existing.license_key, note: "Already issued", tier });

  // 推荐码解析：webhook 自定义字段优先，否则按邮箱匹配申请意图
  const refCode = body.referred_by || body.ref || store.getPendingReferralByEmail(email) || null;

  const license_key = generateLicense();
  const issuedAt = Date.now();
  const integrity = signLicense(license_key, email, tier, issuedAt); // 共享时间戳 → 可被 verifyIntegrity 校验
  store.addLicense({
    license_key, email, tier,
    issued_at: issuedAt,
    integrity,
    gumroad_transaction_id: body.sale_id || body.id || "",
    gumroad_purchase: true,
    referred_by: refCode || "",
    referral_extra_days: 0,
    active: true,
  });

  // 仅在真实付款后发推荐奖励（防刷逻辑在 store.awardReferral 内）
  if (refCode) {
    const award = store.awardReferral(refCode, email, tier);
    if (award && award.awarded) console.log("[referral] awarded", award.reward_days, "days to", award.owner_email, "via", refCode);
    store.removePendingReferral(email);
  }

  return sendJson(res, 200, { ok: true, license_key, tier, referral_awarded: !!refCode });
}

module.exports = { handleGumroadWebhook, verifyGumroad };

// ─── 独立测试服务：node server/webhook.js ───
// 仅用于本地联调，直接复用上面的 handleGumroadWebhook（不重复实现逻辑）。
if (require.main === module) {
  const http = require("http");
  const PORT = process.env.WEBHOOK_TEST_PORT || 3002;
  http.createServer((req, res) => handleGumroadWebhook(req, res)).listen(PORT, () => {
    console.log(`Gumroad Webhook test server on http://localhost:${PORT}`);
    console.log('POST form: email=a@b.com&product_permalink=/modelhub-lifetime');
    console.log("Dev mode (no GUMROAD_SECRET): signature check skipped. Set GUMROAD_SECRET to enforce.");
  });
}
