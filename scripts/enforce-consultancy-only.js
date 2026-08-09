/**
 * Keep General Consultation + Grooming active.
 * OPD counters → consultation; Grooming counter → grooming.
 *
 * Prefer: node scripts/enable-grooming.js
 */
require('dotenv').config();
const mysql = require('mysql2/promise');

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  console.log('Connected:', process.env.DB_NAME);

  await conn.query(`
    UPDATE qms_service_types
    SET is_active = CASE
      WHEN LOWER(name) LIKE '%consult%' OR LOWER(name) LIKE '%opd%' OR LOWER(name) LIKE '%groom%' THEN 1
      ELSE 0
    END
  `);

  const [branches] = await conn.query('SELECT id, name FROM qms_branches WHERE is_active = 1');
  for (const b of branches) {
    const [consult] = await conn.query(
      `SELECT id FROM qms_service_types
       WHERE branch_id = ? AND is_active = 1
         AND (LOWER(name) LIKE '%consult%' OR LOWER(name) LIKE '%opd%')
       ORDER BY display_order, id LIMIT 1`,
      [b.id]
    );
    const [grooming] = await conn.query(
      `SELECT id FROM qms_service_types
       WHERE branch_id = ? AND is_active = 1
         AND (LOWER(name) LIKE '%groom%' OR prefix = 'G')
       ORDER BY display_order, id LIMIT 1`,
      [b.id]
    );

    if (consult.length) {
      await conn.query(
        `UPDATE qms_counters
         SET service_type_id = ?
         WHERE branch_id = ? AND LOWER(name) LIKE '%opd%'`,
        [consult[0].id, b.id]
      );
    }
    if (grooming.length) {
      await conn.query(
        `UPDATE qms_counters
         SET service_type_id = ?, name = 'Grooming'
         WHERE branch_id = ? AND LOWER(name) LIKE '%groom%'`,
        [grooming[0].id, b.id]
      );
    }
  }

  const [active] = await conn.query(
    `SELECT b.name AS branch_name, s.name AS service_name
     FROM qms_branches b
     JOIN qms_service_types s ON s.branch_id = b.id AND s.is_active = 1
     ORDER BY b.name, s.display_order, s.id`
  );

  console.log('Active services by branch:');
  active.forEach((r) => console.log(`- ${r.branch_name}: ${r.service_name}`));

  await conn.end();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
