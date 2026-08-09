/**
 * Ensure display_video_url column exists and seed default YouTube reel.
 * Usage: node scripts/ensure-display-video.js
 */
require('dotenv').config();
const { pool, executeQuery, connectDB } = require('../config/database');

const DEFAULT_VIDEO = 'https://www.youtube.com/watch?v=gcUHp8Wm7D0';

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
  if (!(await columnExists('display_video_url'))) {
    await executeQuery(
      `ALTER TABLE qms_branches ADD COLUMN display_video_url VARCHAR(500) DEFAULT NULL`
    );
    console.log('Added qms_branches.display_video_url');
  } else {
    console.log('display_video_url already exists');
  }

  await executeQuery(
    `UPDATE qms_branches
     SET display_video_url = ?
     WHERE display_video_url IS NULL OR TRIM(display_video_url) = ''`,
    [DEFAULT_VIDEO]
  );

  const rows = await executeQuery(
    `SELECT id, name, slug, display_video_url FROM qms_branches ORDER BY id`
  );
  rows.forEach((r) => {
    console.log(`- ${r.name} (${r.slug}): ${r.display_video_url || '(empty)'}`);
  });
  console.log('OK: display video ready');
  await pool.end();
}

main().catch(async (err) => {
  console.error('Failed:', err.message);
  try { await pool.end(); } catch (_) { /* ignore */ }
  process.exit(1);
});
