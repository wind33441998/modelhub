// POST /api/paypal-capture  →  captures a PayPal order, verifies amount, issues a license.
// Body: { orderID, tier, email, ref?, test? }
const { json, handleOptions } = require("./_lib/http");
const { getToken, paypalBase, PRICES } = require("./_lib/paypal");
const { issueLicense } = require("./_lib/issue");

const VALID_TIERS = Object.keys(PRICES);

function expectedAmount(tier, test) {
  return test ? "0.01" : String(PRICES[tier]);
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return handleOptions(res);
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  let body = {};
  try { body = JSON.parse(req.body || "{}"); } catch (e) { return json(res, 400, { error: "Invalid JSON" }); }

  const { orderID, tier, email, ref } = body;
  const test = !!body.test;

  if (!orderID) return json(res, 400, { error: "orderID required" });
  if (!VALID_TIERS.includes(tier) || tier === "trial") return json(res, 400, { error: "Invalid tier" });
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: "Valid email required" });

  const expect = expectedAmount(tier, test);

  try {
    const token = await getToken();
    const r = await fetch(paypalBase() + "/v2/checkout/orders/" + orderID + "/capture", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const j = await r.json();

    const capture = j?.purchase_units?.[0]?.payments?.captures?.[0];
    if (!capture) return json(res, 502, { error: "No capture found", detail: j });
    if (capture.status !== "COMPLETED") return json(res, 402, { error: "Payment not completed", status: capture.status });

    const paid = capture.amount?.value;
    if (paid !== expect) {
      return json(res, 400, { error: "Amount mismatch", expected: expect, paid });
    }

    // Idempotency: don't issue twice for the same capture id.
    const { store } = require("./_lib/issue");
    const existing = await store.findCapture(capture.id);
    if (existing) {
      return json(res, 200, {
        ok: true, alreadyIssued: true,
        license_key: existing.license_key, email: existing.email, tier: existing.tier,
      });
    }

    const lic = await issueLicense({ email, tier, ref, provider: "paypal", captureId: capture.id });

    json(res, 200, {
      ok: true,
      license_key: lic.license_key,
      email: lic.email,
      tier: lic.tier,
      label: lic.label,
      days: lic.days,
      devices: lic.devices,
      referral_extra_days: lic.referral_extra_days,
      capture_id: capture.id,
    });
  } catch (e) {
    console.error("paypal-capture error:", e);
    json(res, 500, { error: e.message || "Internal error" });
  }
};
