/**
 * Activate Grooming service and convert OPD 3 → Grooming station.
 * Keeps OPD 1 / OPD 2 on General Consultation.
 *
 * Usage (from queue-management-system-):
 *   node scripts/enable-grooming.js
 */
require('dotenv').config();
const mysql = require('mysql2/promise');

async function ensureGroomingService(conn, branchId) {
  const [existing] = await conn.query(
    `SELECT id FROM qms_service_types
     WHERE branch_id = ? AND (LOWER(name) LIKE '%groom%' OR prefix = 'G')
     ORDER BY id LIMIT 1`,
    [branchId]
  );
  if (existing.length) {
    await conn.query(
      `UPDATE qms_service_types
       SET is_active = 1, name = 'Grooming', prefix = 'G', color = '#D97706', display_order = 3
       WHERE id = ?`,
      [existing[0].id]
    );
    return existing[0].id;
  }

  const [result] = await conn.query(
    `INSERT INTO qms_service_types (branch_id, name, prefix, color, display_order, is_active)
     VALUES (?, 'Grooming', 'G', '#D97706', 3, 1)`,
    [branchId]
  );
  return result.insertId;
}

async function ensureConsultationActive(conn, branchId) {
  await conn.query(
    `UPDATE qms_service_types
     SET is_active = 1
     WHERE branch_id = ?
       AND (LOWER(name) LIKE '%consult%' OR LOWER(name) LIKE '%opd%')`,
    [branchId]
  );
  const [rows] = await conn.query(
    `SELECT id FROM qms_service_types
     WHERE branch_id = ? AND is_active = 1
       AND (LOWER(name) LIKE '%consult%' OR LOWER(name) LIKE '%opd%')
     ORDER BY display_order, id LIMIT 1`,
    [branchId]
  );
  return rows[0]?.id || null;
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

  // Keep consult + grooming active; deactivate other categories (vaccination/emergency)
  await conn.query(`
    UPDATE qms_service_types
    SET is_active = CASE
      WHEN LOWER(name) LIKE '%consult%' OR LOWER(name) LIKE '%opd%' OR LOWER(name) LIKE '%groom%' THEN 1
      ELSE 0
    END
  `);

  const [branches] = await conn.query('SELECT id, name, slug FROM qms_branches WHERE is_active = 1');
  for (const branch of branches) {
    const consultId = await ensureConsultationActive(conn, branch.id);
    const groomingId = await ensureGroomingService(conn, branch.id);
    if (!consultId || !groomingId) {
      console.warn(`Skip ${branch.name}: missing consult (${consultId}) or grooming (${groomingId})`);
      continue;
    }

    // OPD-named counters stay on consultation
    await conn.query(
      `UPDATE qms_counters
       SET service_type_id = ?
       WHERE branch_id = ? AND is_active = 1 AND LOWER(name) LIKE '%opd%'`,
      [consultId, branch.id]
    );

    // Prefer converting existing OPD 3 → Grooming; else convert highest OPD station
    const [opd3] = await conn.query(
      `SELECT id FROM qms_counters
       WHERE branch_id = ? AND is_active = 1
         AND (LOWER(name) REGEXP 'opd[[:space:]]*3' OR LOWER(name) = 'grooming')
       ORDER BY id ASC LIMIT 1`,
      [branch.id]
    );

    let groomingCounterId = opd3[0]?.id || null;
    if (!groomingCounterId) {
      const [lastOpd] = await conn.query(
        `SELECT id FROM qms_counters
         WHERE branch_id = ? AND is_active = 1 AND LOWER(name) LIKE '%opd%'
         ORDER BY id DESC LIMIT 1`,
        [branch.id]
      );
      // Keep at least one OPD for consultation when converting the last OPD-named station
      const [opdCount] = await conn.query(
        `SELECT COUNT(*) AS c FROM qms_counters
         WHERE branch_id = ? AND is_active = 1 AND LOWER(name) LIKE '%opd%'`,
        [branch.id]
      );
      if (lastOpd.length && Number(opdCount[0].c) >= 2) {
        groomingCounterId = lastOpd[0].id;
      }
    }

    if (groomingCounterId) {
      await conn.query(
        `UPDATE qms_counters SET name = 'Grooming', service_type_id = ? WHERE id = ?`,
        [groomingId, groomingCounterId]
      );
      console.log(`${branch.name}: counter #${groomingCounterId} → Grooming`);
    } else {
      const [result] = await conn.query(
        `INSERT INTO qms_counters (branch_id, name, service_type_id, is_active)
         VALUES (?, 'Grooming', ?, 1)`,
        [branch.id, groomingId]
      );
      console.log(`${branch.name}: created Grooming counter #${result.insertId}`);
    }

    // Any counter already named Grooming must point at grooming service
    await conn.query(
      `UPDATE qms_counters
       SET service_type_id = ?, name = 'Grooming'
       WHERE branch_id = ? AND LOWER(name) LIKE '%groom%'`,
      [groomingId, branch.id]
    );
  }

  const [summary] = await conn.query(
    `SELECT b.name AS branch_name, c.name AS counter_name, s.name AS service_name
     FROM qms_counters c
     JOIN qms_branches b ON b.id = c.branch_id
     LEFT JOIN qms_service_types s ON s.id = c.service_type_id
     WHERE c.is_active = 1
     ORDER BY b.name, c.id`
  );
  console.log('\nActive counters:');
  summary.forEach((r) => console.log(`- ${r.branch_name}: ${r.counter_name} → ${r.service_name}`));

  await conn.end();
  console.log('\nDone. Restart QMS and hard-refresh kiosk/display/POS.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
