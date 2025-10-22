// src/centrifugo/notification.service.js
const { publish } = require("../centrifugo/centrifugo.service.js");

const CHANNEL = (process.env.CENTRIFUGO_SUB_CHANNEL || "notification#mock_logging").replace(/^"|"$/g, ""); // bỏ dấu " nếu có trong .env

/**
 * Gọi hàm này NGAY SAU KHI insert vào project_request_logs
 * @param {number} projectRequestLogId
 * @param {object} db  // node-postgres Pool/Client: phải có .query(sql, params)
 */

function buildChannels(row) {
  const chans = [];
  if (row.project_id) chans.push(`notification#project_${row.project_id}`);
  if (row.user_id) chans.push(`user_${row.user_id}#notifications`);
  //  kênh chung để mọi client đều nhận được
  if (CHANNEL) chans.push(CHANNEL);
  return chans;
}

async function onProjectLogInserted(projectRequestLogId, db) {
  if (!db?.query) throw new Error("onProjectLogInserted: missing db");

  // Lấy đủ thông tin để quyết định kênh
  const sel = await db.query(
    `
    SELECT prl.id AS log_id,
           prl.endpoint_id,
           prl.user_id,
           prl.project_id,               
           COALESCE(e.is_stateful, FALSE)       AS is_stateful,
           COALESCE(e.send_notification, FALSE) AS send_notification
    FROM project_request_logs prl
    LEFT JOIN endpoints e ON e.id = prl.endpoint_id
    WHERE prl.id = $1
  `,
    [projectRequestLogId]
  );

  const row = sel.rows?.[0];
  if (!row) return null;
  if (!row.send_notification) return null;

  const ins = await db.query(
    `
    INSERT INTO notifications(project_request_log_id, endpoint_id, user_id, is_stateful, is_read)
    VALUES ($1, $2, $3, $4, FALSE)
    RETURNING *
  `,
    [row.log_id, row.endpoint_id, row.user_id, row.is_stateful]
  );

  const notif = ins.rows?.[0];

  // Fanout tới các kênh đích
  const channels = buildChannels(row);
  for (const ch of channels) {
    await publish(ch, { notification: notif });
  }

  return notif;
}

module.exports = { onProjectLogInserted };
