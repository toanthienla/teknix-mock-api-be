// src/centrifugo/centrifugo.service.js
const axios = require("axios");
require("dotenv").config();
const need = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env ${k}`);
  return v;
};
const BASE = need("CENTRIFUGO_HTTP").replace(/\/+$/, "");
const API_KEY = need("CENTRIFUGO_API_KEY");

function logDebug(...args) {
  // Bật tạm thời, xong việc có thể tắt
  console.log("[centrifugo]", ...args);
}

/**
 * Publish qua RPC /api
 * @param {string} channel
 * @param {object} data
 */
async function publish(channel, data = {}) {
  const url = `${BASE}/api`;
  const cmd = { method: "publish", params: { channel, data } };

  logDebug("POST", url, { keylen: API_KEY ? API_KEY.length : 0, channel });

  try {
    const { data: res } = await axios.post(url, cmd, {
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": API_KEY,
        Authorization: `apikey ${API_KEY}`, // để tương thích
      },
      timeout: 5000,
    });
    logDebug("OK");
    return res;
  } catch (e) {
    const status = e?.response?.status;
    const body = e?.response?.data;
    logDebug("ERROR", status, body);
    throw e;
  }
}

module.exports = { publish };
