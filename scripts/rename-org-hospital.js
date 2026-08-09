require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  const [result] = await conn.query(
    `UPDATE qms_organizations SET name = 'PetZone Hospital' WHERE slug = 'petzone'`
  );
  console.log('org updated rows:', result.affectedRows);

  const [rows] = await conn.query('SELECT id, name, slug FROM qms_organizations');
  console.log(rows);
  await conn.end();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
