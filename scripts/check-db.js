require('dotenv').config({ path: require('path').join(__dirname, '../backend/.env') });
const mysql = require('mysql2/promise');

const config = {
  host: process.env.DB_HOST || 'h40.eu.core.hostnext.net',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  multipleStatements: true,
};

async function main() {
  console.log('Connecting to', config.host, 'as', config.user);
  const conn = await mysql.createConnection(config);
  const [dbs] = await conn.query('SHOW DATABASES');
  console.log('\nDatabases:');
  dbs.forEach((r) => console.log(' -', r.Database));

  const qmsDb = dbs.map((r) => r.Database).find((d) => /queue/i.test(d));
  const target = qmsDb || process.env.DB_NAME || 'petzonep_software';
  console.log('\nTarget database:', target);

  await conn.query(`USE \`${target}\``);
  const [tables] = await conn.query("SHOW TABLES LIKE 'qms_%'");
  console.log('Existing qms tables:', tables.length);
  tables.forEach((t) => console.log(' -', Object.values(t)[0]));

  await conn.end();
  console.log('\nConnection OK');
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
