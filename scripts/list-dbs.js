require('dotenv').config();
const mysql = require('mysql2/promise');

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });

  const [dbs] = await conn.query('SHOW DATABASES');
  const names = dbs.map((r) => r.Database);
  console.log('All databases:');
  names.forEach((n) => console.log(' ', n));

  const matches = names.filter((n) => /queue|management/i.test(n));
  console.log('\nQueue/management matches:', matches.length ? matches.join(', ') : 'none');

  await conn.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
