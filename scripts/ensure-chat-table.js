/**
 * One-time / safe ensure for clinic chat table (cPanel friendly).
 * Usage: node scripts/ensure-chat-table.js
 */
require('dotenv').config();
const { pool, executeQuery, connectDB } = require('../config/database');

async function main() {
  await connectDB();
  await executeQuery(`
    CREATE TABLE IF NOT EXISTS qms_chat_messages (
      id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      branch_id    INT UNSIGNED NOT NULL,
      sender_name  VARCHAR(80)  NOT NULL,
      sender_role  VARCHAR(40)  DEFAULT NULL,
      body         VARCHAR(500) NOT NULL,
      created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_chat_branch FOREIGN KEY (branch_id) REFERENCES qms_branches(id) ON DELETE CASCADE,
      KEY idx_chat_branch_id (branch_id, id),
      KEY idx_chat_branch_created (branch_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  console.log('OK: qms_chat_messages is ready');
  await pool.end();
}

main().catch(async (err) => {
  console.error('Failed:', err.message);
  try { await pool.end(); } catch (_) { /* ignore */ }
  process.exit(1);
});
