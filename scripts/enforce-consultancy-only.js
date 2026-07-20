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
      WHEN LOWER(name) LIKE '%consult%' OR LOWER(name) LIKE '%opd%' THEN 1
      ELSE 0
    END
  `);

  const [branches] = await conn.query('SELECT id, name FROM qms_branches WHERE is_active = 1');
  for (const b of branches) {
    const [svc] = await conn.query(
      `SELECT id FROM qms_service_types
       WHERE branch_id = ? AND is_active = 1
       ORDER BY display_order, id LIMIT 1`,
      [b.id]
    );
    if (!svc.length) continue;

    await conn.query(
      `UPDATE qms_counters
       SET service_type_id = ?
       WHERE branch_id = ?`,
      [svc[0].id, b.id]
    );
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
