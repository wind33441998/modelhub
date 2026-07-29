module.exports = (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, message: "ModelHub API is live" }));
};
