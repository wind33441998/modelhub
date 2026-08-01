// ModelHub Gumroad Webhook — 单一权威实现 (single source of truth)
//
// 职责：Gumroad 付款通知 → 自动发放 License Key。
// 同时被 server/server.js 挂载（路由 /api/webhook/gumroad）以及可被 `node server/webhook.js`
// 直接以独立测试服务运行（:3002）。业务逻辑只有这一份，避免与 server.js 内联副本漂移。
//
// 安全：Gumroad 的 Ping 不发送签名头（X-Gumroad-Signature 不存在），官方也不提供 webhook 签名密钥。
// 可靠的验证方式 = 把「共享密钥」作为 ?token= 参数拼在回调 URL 里（仅你与 Gumroad 知晓此 URL）。
//   - dev 模式（GUMROAD_SECRET 未设或为默认值）：不强制校验，仅告警（便于本地联调）。
//   - 生产模式（配置了真实密钥）：URL 的 token 参数须等于 GUMROAD_SECRET，否则 401 拒绝。
//   - 冗余防御：若请求恰好带 X-Gumroad-Signature 头，也做一次 HMAC 校验（Gumroad 实际不发）。

const crypto = require("crypto");
const GUMROAD_SECRET = process.env.GUMROAD_SECRET || "dev-gumroad-secret";

// 与主授权服务复用同一套存储 + 签名逻辑，保证行为一致
const store = require("./lib/store");
const { signLicense, generateLicense } = require("./lib/crypto");

// Gumroad product_permalink → 内部 tier 映射
// 仅用于「独立商品对应单一套餐」的情形（推荐新建商品时采用 modelhub-* 规范命名）。
// 注：早期在 Gumroad 后台建的商品 permalink 为 `swpiot`，它是「单商品 + 多 versions
// （月/年/终身）」结构，所有购买的 product_permalink 都相同，无法用本表映射，故不在此列出，
// 其套餐识别完全交给 detectTier()（按价格/版本名）。
const PERMALINK_MAP = {
  "modelhub-trial": "trial",
  "modelhub-monthly": "monthly",
  "modelhub-yearly": "yearly",
  "modelhub-lifetime": "lifetime",
};
// 注：`swpiot` 是「单商品 + 多 versions（月/年/终身）」结构，所有购买的 product_permalink
// 都相同（恒为 /swpiot），必须靠价格/版本名区分套餐，故不放进 PERMALINK_MAP（否则会被
// 误判为单一终身档）。其套餐识别完全交给下方 detectTier() 处理。

// 套餐识别：Gumroad 对「单商品 + 多 versions」结构，所有购买的 product_permalink 都相同
// （如本例永远为 /swpiot），必须靠 价格 / 版本名 区分月付/年付/终身，否则会全部错发终身码。
// 识别优先级：①permalink 精确匹配（拆分独立商品时）②版本名关键词 ③价格(分) ④兜底。
function detectTier(body, tierKey) {
  if (PERMALINK_MAP[tierKey]) return PERMALINK_MAP[tierKey];

  const text = [
    body.product_name, body.resource_name, body.variant,
    body.variants_text, JSON.stringify(body.variants || ""),
  ].filter(Boolean).join(" ").toLowerCase();
  if (/lifetime|终身|永久/.test(text)) return "lifetime";
  if (/yearly|年付|年租/.test(text)) return "yearly";
  if (/monthly|月付|月租/.test(text)) return "monthly";

  const price = Number(body.price);
  if (price) {
    const usd = price >= 100 ? price / 100 : price; // 兼容「分」与「元」
    if (Math.abs(usd - 69) < 1) return "lifetime";
    if (Math.abs(usd - 29) < 1) return "yearly";
    if (Math.abs(usd - 3) < 1) return "monthly";
  }

  // 兜底：已知版本化商品(swpiot)默认终身（其主推档即终身）；
  // 其它未知 permalink 默认月付（低权限，避免把未知付费单错发终身造成资损）。
  return tierKey === "swpiot" ? "lifetime" : "monthly";
}

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
  const url = new URL(req.url, "http://localhost");
  const token = url.searchParams.get("token");
  const sig = req.headers["x-gumroad-signature"] || req.headers["X-Gumroad-Signature"];

  // 鉴权：生产模式要求 URL token 匹配，或（冗余）签名有效；否则拒绝。
  const isDev = !GUMROAD_SECRET || GUMROAD_SECRET === "dev-gumroad-secret";
  if (!isDev) {
    const tokenOk = !!token && token === GUMROAD_SECRET;
    const sigOk = verifyGumroad(raw, sig, GUMROAD_SECRET);
    if (!tokenOk && sigOk !== true) {
      console.warn("[Webhook] rejected: token mismatch and no valid signature");
      return sendJson(res, 401, { ok: false, error: "Unauthorized" });
    }
  } else {
    console.warn("[Webhook] dev mode: token/signature verification skipped (set GUMROAD_SECRET in production)");
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const permalink = body.product_permalink || body.permalink || "";
  const tierKey = String(permalink).split("/").filter(Boolean).pop() || "";
  const tier = detectTier(body, tierKey);
  // 调试：打印关键字段，便于首笔真实订单后校准映射（确认无误后可删）。
  console.log("[Webhook] detectTier:", JSON.stringify({ tierKey, price: body.price, product_name: body.product_name, variant: body.variant, tier }));

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
  let referralAwarded = false;
  if (refCode) {
    const award = store.awardReferral(refCode, email, tier);
    if (award && award.awarded) {
      console.log("[referral] awarded", award.reward_days, "days to", award.owner_email, "via", refCode);
      referralAwarded = true;
    }
    store.removePendingReferral(email);
  }

  return sendJson(res, 200, { ok: true, license_key, tier, referral_awarded: referralAwarded });
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
