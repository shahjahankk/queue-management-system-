/**
 * Ensure OPD/Kiosk screen PIN columns exist (cPanel friendly).
 * Usage: node scripts/ensure-screen-pins.js
 */
require('dotenv').config();
const { pool, executeQuery, connectDB } = require('../config/database');

async function columnExists(name) {
  const rows = await executeQuery(
    `SELECT COUNT(*) AS c
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'qms_branches'
       AND COLUMN_NAME = ?`,
    [name]
  );
  return Number(rows[0]?.c || 0) > 0;
}

async function main() {
  await connectDB();
  if (!(await columnExists('counter_pin'))) {
    await executeQuery(`ALTER TABLE qms_branches ADD COLUMN counter_pin VARCHAR(32) DEFAULT NULL`);
    console.log('Added qms_branches.counter_pin');
  } else {
    console.log('counter_pin already exists');
  }
  if (!(await columnExists('kiosk_pin'))) {
    await executeQuery(`ALTER TABLE qms_branches ADD COLUMN kiosk_pin VARCHAR(32) DEFAULT NULL`);
    console.log('Added qms_branches.kiosk_pin');
  } else {
    console.log('kiosk_pin already exists');
  }
  console.log('OK: screen PIN columns ready');
  await pool.end();
}

main().catch(async (err) => {
  console.error('Failed:', err.message);
  try { await pool.end(); } catch (_) { /* ignore */ }
  process.exit(1);
});
