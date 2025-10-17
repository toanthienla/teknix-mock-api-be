const axios = require("axios");
const CENT_HTTP = process.env.CENTRIFUGO_HTTP || "http://127.0.0.1:8000";
const API_KEY = process.env.CENTRIFUGO_API_KEY || "my_centrifugo";

const http = axios.create({
  baseURL: CENT_HTTP,
  timeout: 5000,
  headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
});

async function publish(channel, data) {
  const { data: res } = await http.post("/api/publish", { channel, data });
  return res;
}

module.exports = { publish };
