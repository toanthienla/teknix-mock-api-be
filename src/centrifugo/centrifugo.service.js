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
  console.log("[centrifugo]", ...args);
}

async function publish(channel, data = {}) {
  const url = `${BASE}/api`;
  const cmd = { method: "publish", params: { channel, data } };

  logDebug("POST", url, { keylen: API_KEY ? API_KEY.length : 0, channel });

  try {
    const { data: res } = await axios.post(url, cmd, {
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": API_KEY,
        Authorization: `apikey ${API_KEY}`,
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

/**
 * Publish theo project (kênh pj:{projectId})
 * Phù hợp với token /centrifugo/project-connect-token (subs pj:{projectId})
 */
async function publishToProjectChannel(projectId, data = {}) {
  if (!projectId) throw new Error("projectId required for publishToProjectChannel");
  const channel = `pj:${projectId}`;
  return publish(channel, data);
}

/**
 * Optional: publish theo endpoint (kênh pj:{projectId}-ep-{endpointId})
 * Phù hợp với token /centrifugo/endpoint-connect-token
 */
async function publishToEndpointChannel(projectId, endpointId, data = {}) {
  if (!projectId) throw new Error("projectId required for publishToEndpointChannel");
  const base = `pj:${projectId}`;
  const channel = endpointId ? `${base}-ep-${endpointId}` : base;
  return publish(channel, data);
}

module.exports = { publish, publishToProjectChannel, publishToEndpointChannel };
