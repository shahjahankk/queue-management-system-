/**
 * Set default OPD + Take-a-Ticket screen passwords for all branches.
 * Usage: node scripts/set-default-screen-pins.js [password]
 * Default password: 1234
 */
require('dotenv').config();
const { pool, executeQuery, connectDB } = require('../config/database');

async function main() {
  const pin = String(process.argv[2] || '1234').trim().slice(0, 32);
  if (!pin) throw new Error('Password cannot be empty');

  await connectDB();
  await executeQuery(
    `UPDATE qms_branches SET counter_pin = ?, kiosk_pin = ?`,
    [pin, pin]
  );

  const rows = await executeQuery(
    `SELECT id, name, slug,
            (counter_pin IS NOT NULL AND counter_pin <> '') AS has_counter_pin,
            (kiosk_pin IS NOT NULL AND kiosk_pin <> '') AS has_kiosk_pin
     FROM qms_branches
     ORDER BY id`
  );

  console.log('Updated branches:');
  rows.forEach((r) => {
    console.log(
      `- ${r.name} (${r.slug}): OPD=${r.has_counter_pin ? 'LOCKED' : 'open'}, Ticket=${r.has_kiosk_pin ? 'LOCKED' : 'open'}`
    );
  });
  console.log('Done. Change anytime from Admin → Branches.');
  await pool.end();
}

main().catch(async (err) => {
  console.error('Failed:', err.message);
  try { await pool.end(); } catch (_) { /* ignore */ }
  process.exit(1);
});
