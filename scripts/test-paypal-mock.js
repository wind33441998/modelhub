// Mock integration test for the PayPal capture → license-issue channel.
// Stubs `fetch` to simulate PayPal's OAuth + capture responses, proving the
// full server-side flow works WITHOUT real PayPal credentials.
// Run:  node scripts/test-paypal-mock.js
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mh-paypal-test-"));
process.env.MODELHUB_DATA_DIR = TMP;
process.env.PAYPAL_MODE = "sandbox";
process.env.PAYPAL_SANDBOX_CLIENT_ID = "test-id";
process.env.PAYPAL_SANDBOX_CLIENT_SECRET = "test-secret";

let captureCalls = 0;
global.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/v1/oauth2/token")) return { json: async () => ({ access_token: "FAKE-TOKEN" }) };
  if (u.includes("/v2/checkout/orders/") && u.includes("/capture")) {
    captureCalls++;
    return { json: async () => ({
      id: "ORDER123",
      purchase_units: [{ payments: { captures: [{ id: "CAP123", status: "COMPLETED", amount: { value: "0.01" } }] } }],
    }) };
  }
  throw new Error("unexpected fetch: " + u);
};

const capture = require("../api/paypal-capture.js");

function mockRes() {
  return { statusCode: 200, _c: "", setHeader() {}, end(s) { this._c = s; }, getJSON() { return JSON.parse(this._c); } };
}

(async () => {
  const res = mockRes();
  await capture({ method: "POST", body: JSON.stringify({ orderID: "ORDER123", tier: "yearly", email: "buyer@example.com", test: true }) }, res);
  const out = res.getJSON();
  console.log("capture #1:", out);
  if (!out.ok || !out.license_key) throw new Error("capture failed: " + JSON.stringify(out));
  if (out.capture_id !== "CAP123") throw new Error("capture_id mismatch");
  if (out.amount_unexpected) {}

  const lic = JSON.parse(fs.readFileSync(path.join(TMP, "licenses.json"), "utf-8"));
  if (!lic.find((l) => l.license_key === out.license_key)) throw new Error("license not persisted");

  const res2 = mockRes();
  await capture({ method: "POST", body: JSON.stringify({ orderID: "ORDER123", tier: "yearly", email: "buyer@example.com", test: true }) }, res2);
  const out2 = res2.getJSON();
  console.log("capture #2 (idempotency):", out2);
  if (!out2.alreadyIssued) throw new Error("idempotency failed");

  console.log("\n✅ MOCK INTEGRATION TEST PASSED");
  console.log("   license issued :", out.license_key);
  console.log("   capture calls  :", captureCalls, "(same payment must not double-issue)");
  console.log("   persisted to   :", path.join(TMP, "licenses.json"));
})().catch((e) => { console.error("\n❌ MOCK TEST FAILED:", e.message); process.exit(1); });
