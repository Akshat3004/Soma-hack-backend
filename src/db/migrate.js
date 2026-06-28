import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Applies every .sql file in src/db/migrations in lexical order.
 * Migrations must be idempotent (CREATE ... IF NOT EXISTS) so re-running
 * is always safe. Run with: npm run db:migrate
 */
async function migrate() {
  const dir = join(__dirname, 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = await readFile(join(dir, file), 'utf8');
    process.stdout.write(`Applying ${file} ... `);
    await pool.query(sql);
    console.log('ok');
  }
  console.log(`Applied ${files.length} migration(s).`);
}

migrate()
  .catch((err) => {
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
