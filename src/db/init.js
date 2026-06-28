import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Applies src/db/schema.sql to the configured database.
 * Run with: npm run db:init
 */
async function init() {
  const sqlPath = join(__dirname, 'schema.sql');
  const sql = await readFile(sqlPath, 'utf8');

  console.log(`Applying ${sqlPath} ...`);
  await pool.query(sql);
  console.log('Schema applied successfully.');
}

init()
  .catch((err) => {
    console.error('Schema init failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
