// ModelHub Gumroad Webhook — 处理购买通知，自动发放 License Key
// 部署为 Vercel Serverless Function 或 Node.js 独立服务

const crypto = require("crypto");

// ─── HMAC License Key 生成 ───
const HMAC_KEY = process.env.MODELHUB_HMAC_KEY || "dev-hmac-key-change-in-prod";

function generateLicenseKey() {
  const raw = crypto.randomBytes(8).toString("hex").toUpperCase();
  return "MHUB-" + raw.match(/.{1,4}/g).join("-");
}

const TIERS = {
  trial:    { days: 7,    devices: 1,  label: "Trial" },
  monthly:  { days: 30,   devices: 3,  label: "Monthly" },
  yearly:   { days: 365,  devices: 5,  label: "Yearly" },
  lifetime: { days: 36500, devices: 10, label: "Lifetime" },
};

// Gumroad permalink → tier 映射
const PERMALINK_MAP = {
  "modelhub-trial":     "trial",
  "modelhub-monthly":   "monthly",
  "modelhub-yearly":    "yearly",
  "modelhub-lifetime":  "lifetime",
  "swpiot":             "trial",   // 主商品 ID 默认试���
};

// ─── Gumroad Webhook Handler ───
// Gumroad sends POST with form-encoded data on sale/refund/subscription events
async function handleWebhook(body, headers) {
  const { email, product_permalink, license_key, sale_id, timestamp, action } = body;

  // Map to tier
  const tier = PERMALINK_MAP[product_permalink] || "monthly";

  // Generate or use Gumroad's built-in license key
  const lk = license_key || generateLicenseKey();

  console.log(`[Webhook] ${action || "sale"} | ${email} | ${tier} | ${lk}`);

  // Store in database (implement based on your storage backend)
  // await store.addLicense({ license_key: lk, email, tier, issued_at: Date.now(), ... });

  return { ok: true, license_key: lk, tier };
}

// ─── Vercel Serverless Handler ───
module.exports = async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end("");

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // Gumroad sends URL-encoded or JSON
    let body;
    if (req.headers["content-type"]?.includes("application/json")) {
      body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } else {
      // URL-encoded form data
      const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      body = Object.fromEntries(new URLSearchParams(raw));
    }

    const result = await handleWebhook(body, req.headers);
    res.status(200).json(result);
  } catch (e) {
    console.error("[Webhook Error]", e.message);
    res.status(500).json({ error: e.message });
  }
};

// ─── Standalone test ───
if (require.main === module) {
  const http = require("http");
  http.createServer((req, res) => {
    let data = "";
    req.on("data", c => data += c);
    req.on("end", async () => {
      try {
        const result = await handleWebhook(
          Object.fromEntries(new URLSearchParams(data)),
          req.headers
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  }).listen(3002, () => {
    console.log("Gumroad Webhook test server running on http://localhost:3002");
    console.log("Configure Gumroad to POST to: http://YOUR_SERVER:3002/api/webhook/gumroad");
  });
}
