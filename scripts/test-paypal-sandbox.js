// Real PayPal SANDBOX connectivity test. Creates a $0.01 order to prove the
// REST API credentials work. (Full capture requires a sandbox buyer approving
// in the browser — see checkout.html ?test=1 flow.)
// Requires env: PAYPAL_MODE=sandbox, PAYPAL_SANDBOX_CLIENT_ID, PAYPAL_SANDBOX_CLIENT_SECRET
// Run:  PAYPAL_MODE=sandbox PAYPAL_SANDBOX_CLIENT_ID=xxx PAYPAL_SANDBOX_CLIENT_SECRET=yyy node scripts/test-paypal-sandbox.js
const { getToken, paypalBase } = require("../api/_lib/paypal");

(async () => {
  if (process.env.PAYPAL_MODE !== "sandbox") { console.error("Set PAYPAL_MODE=sandbox first."); process.exit(1); }
  const token = await getToken();
  const r = await fetch(paypalBase() + "/v2/checkout/orders", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ intent: "CAPTURE", purchase_units: [{ description: "ModelHub $0.01 test", amount: { currency_code: "USD", value: "0.01" } }] }),
  });
  const j = await r.json();
  if (!j.id) { console.error("❌ order create failed:", j); process.exit(1); }
  console.log("✅ Sandbox order created:", j.id, "status:", j.status);
  console.log("\nTo complete the $0.01 end-to-end test:");
  console.log("  1. Put these same creds in Vercel env (PAYPAL_MODE=sandbox + PAYPAL_SANDBOX_CLIENT_ID/SECRET).");
  console.log("  2. Deploy (git push).");
  console.log("  3. Open https://claude-proxys.com/checkout.html?tier=yearly&test=1");
  console.log("  4. Log in with a PayPal SANDBOX buyer account, pay $0.01.");
  console.log("  5. Your license key appears on the page (and in the license store).");
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
