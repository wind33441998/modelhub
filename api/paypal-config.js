// GET /api/paypal-config  →  returns public client id + mode for the PayPal JS SDK.
// Secret is NEVER returned here.
const { json, handleOptions } = require("./_lib/http");
const { publicClientId, isLive, PRICES } = require("./_lib/paypal");

module.exports = (req, res) => {
  if (req.method === "OPTIONS") return handleOptions(res);
  json(res, 200, {
    clientId: publicClientId(),
    mode: isLive() ? "live" : "sandbox",
    prices: PRICES,
  });
};
