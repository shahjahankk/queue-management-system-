require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const config = {
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  multipleStatements: true,
};

const CANDIDATE_DBS = [
  process.env.DB_NAME,
  'petzonep_queue-management',
  'petzonep_queue_management',
  'petzonep_queuemanagement',
  'petzonep_queue',
].filter(Boolean);

async function findDatabase(conn) {
  const [dbs] = await conn.query('SHOW DATABASES');
  const names = dbs.map((r) => r.Database);

  for (const candidate of CANDIDATE_DBS) {
    if (names.includes(candidate)) return candidate;
  }

  const fuzzy = names.find((n) => /queue/i.test(n));
  return fuzzy || null;
}

async function main() {
  console.log('Connecting to', config.host, '...');
  const conn = await mysql.createConnection(config);

  const target = await findDatabase(conn);
  if (!target) {
    const [dbs] = await conn.query('SHOW DATABASES');
    console.error('No queue database found. Available:', dbs.map((r) => r.Database).join(', '));
    process.exit(1);
  }

  console.log('Using database:', target);
  await conn.query(`USE \`${target}\``);

  const schemaPath = path.join(__dirname, '../database/schema.sql');
  let sql = fs.readFileSync(schemaPath, 'utf8');

  const [existing] = await conn.query("SHOW TABLES LIKE 'qms_organizations'");
  if (existing.length > 0) {
    console.log('QMS tables already exist — skipping seed inserts, ensuring tables only.');
    sql = sql.replace(/INSERT INTO qms_organizations[\s\S]*$/m, '');
  }

  console.log('Creating tables...');
  await conn.query(sql);

  const [tables] = await conn.query("SHOW TABLES LIKE 'qms_%'");
  console.log('QMS tables:', tables.map((t) => Object.values(t)[0]).join(', '));

  const [orgs] = await conn.query('SELECT COUNT(*) AS c FROM qms_organizations');
  const [users] = await conn.query('SELECT COUNT(*) AS c FROM qms_users');
  console.log('Organizations:', orgs[0].c, '| Users:', users[0].c);

  await conn.end();
  console.log('Done. Update .env DB_NAME=' + target);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
