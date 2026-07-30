// PayPal REST API helper — picks sandbox/live based on PAYPAL_MODE.
// Client ID + Secret are read from server-side env vars ONLY (never exposed to browser).

function isLive() {
  return process.env.PAYPAL_MODE === "live";
}
function paypalBase() {
  return isLive() ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}
function creds() {
  return isLive()
    ? { id: process.env.PAYPAL_LIVE_CLIENT_ID, secret: process.env.PAYPAL_LIVE_CLIENT_SECRET }
    : { id: process.env.PAYPAL_SANDBOX_CLIENT_ID, secret: process.env.PAYPAL_SANDBOX_CLIENT_SECRET };
}
function publicClientId() {
  return isLive() ? (process.env.PAYPAL_LIVE_CLIENT_ID || "") : (process.env.PAYPAL_SANDBOX_CLIENT_ID || "");
}
async function getToken() {
  const { id, secret } = creds();
  if (!id || !secret) throw new Error("PayPal credentials not configured (PAYPAL_MODE=" + (isLive() ? "live" : "sandbox") + ")");
  const basic = Buffer.from(id + ":" + secret).toString("base64");
  const r = await fetch(paypalBase() + "/v1/oauth2/token", {
    method: "POST",
    headers: { Authorization: "Basic " + basic, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("PayPal auth failed: " + JSON.stringify(j));
  return j.access_token;
}
// USD prices per tier (used for order amount + capture verification).
const PRICES = { trial: 0, monthly: 3, yearly: 29, lifetime: 69 };

module.exports = { isLive, paypalBase, creds, publicClientId, getToken, PRICES };
