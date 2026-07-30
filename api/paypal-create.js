// POST /api/paypal-create  →  creates a PayPal order, returns { orderID }.
// Body: { tier, email, test? }   (test=true forces amount to $0.01 for sandbox verification)
const { json, handleOptions } = require("./_lib/http");
const { getToken, paypalBase, PRICES } = require("./_lib/paypal");

const VALID_TIERS = Object.keys(PRICES);

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return handleOptions(res);
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  let body = {};
  try { body = JSON.parse(req.body || "{}"); } catch (e) { return json(res, 400, { error: "Invalid JSON" }); }

  const tier = body.tier;
  const email = (body.email || "").trim();
  const test = !!body.test;

  if (!VALID_TIERS.includes(tier)) return json(res, 400, { error: "Invalid tier" });
  if (tier === "trial") return json(res, 400, { error: "Trial is free — use /api/register instead" });
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: "Valid email required" });

  const amount = test ? "0.01" : String(PRICES[tier]);

  try {
    const token = await getToken();
    const r = await fetch(paypalBase() + "/v2/checkout/orders", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{
          description: "ModelHub " + tier + " license",
          custom_id: JSON.stringify({ tier, email, test }),
          amount: { currency_code: "USD", value: amount },
        }],
      }),
    });
    const j = await r.json();
    if (!j.id) return json(res, 502, { error: "PayPal order create failed", detail: j });
    json(res, 200, { orderID: j.id, amount, tier, test });
  } catch (e) {
    console.error("paypal-create error:", e);
    json(res, 500, { error: e.message || "Internal error" });
  }
};
