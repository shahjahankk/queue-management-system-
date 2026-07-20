require('dotenv').config();
const mysql = require('mysql2/promise');

async function ensureOpdCounters(conn, branchId, serviceTypeId, targetCount = 3) {
  const [existing] = await conn.query(
    `SELECT id, name FROM qms_counters WHERE branch_id = ? AND is_active = 1 ORDER BY id ASC`,
    [branchId]
  );

  for (let i = 0; i < existing.length; i += 1) {
    const desiredName = `OPD ${i + 1}`;
    if (existing[i].name !== desiredName) {
      await conn.query('UPDATE qms_counters SET name = ? WHERE id = ?', [desiredName, existing[i].id]);
      console.log(`Renamed counter #${existing[i].id} -> ${desiredName}`);
    }
  }

  const missing = targetCount - existing.length;
  for (let i = existing.length + 1; i <= targetCount; i += 1) {
    await conn.query(
      'INSERT INTO qms_counters (branch_id, name, service_type_id) VALUES (?, ?, ?)',
      [branchId, `OPD ${i}`, serviceTypeId]
    );
    console.log(`Added OPD ${i} for branch ${branchId}`);
  }
}

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  console.log('Connected:', process.env.DB_NAME);

  const [branches] = await conn.query('SELECT id, name FROM qms_branches WHERE is_active = 1');
  for (const branch of branches) {
    const [svc] = await conn.query(
      `SELECT id FROM qms_service_types
       WHERE branch_id = ? AND is_active = 1
         AND (LOWER(name) LIKE '%consult%' OR LOWER(name) LIKE '%opd%')
       ORDER BY display_order, id LIMIT 1`,
      [branch.id]
    );
    if (!svc.length) {
      console.log(`Skip ${branch.name}: no consultancy service`);
      continue;
    }

    const target = branch.name.toLowerCase().includes('north') ? 2 : 3;
    await ensureOpdCounters(conn, branch.id, svc[0].id, target);
  }

  const [rows] = await conn.query(
    `SELECT b.name AS branch_name, c.name AS counter_name
     FROM qms_counters c
     JOIN qms_branches b ON b.id = c.branch_id
     WHERE c.is_active = 1
     ORDER BY b.name, c.id`
  );

  console.log('\nActive OPD counters:');
  rows.forEach((r) => console.log(`- ${r.branch_name}: ${r.counter_name}`));

  await conn.end();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
