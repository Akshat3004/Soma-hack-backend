import pg from 'pg';
import { config } from '../config/env.js';

const { Pool } = pg;

// Render/Heroku/Supabase issue self-signed certs on their managed Postgres,
// so we accept them rather than failing verification.
const ssl = config.dbSsl ? { rejectUnauthorized: false } : false;

// GUARDRAIL: pin every connection to UTC at startup so naive API timestamps
// (e.g. "2026-05-17T20:15:00", no offset) are ingested as UTC, not the server's
// local zone. Passed as a libpq startup option so there's no extra round-trip
// or race with the first query. See docs/RESILIENCE.md.
const baseOptions = { ssl, options: '-c timezone=UTC' };

// A single shared connection pool for the whole app.
export const pool = config.databaseUrl
  ? new Pool({ connectionString: config.databaseUrl, ...baseOptions })
  : new Pool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
      ...baseOptions,
    });

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err);
});

/**
 * Run a parameterized query against the pool.
 * @param {string} text - SQL with $1, $2 ... placeholders
 * @param {any[]} [params]
 */
export function query(text, params) {
  return pool.query(text, params);
}

/**
 * Acquire a client for a transaction. Caller MUST release it.
 * Usage:
 *   const client = await getClient();
 *   try { await client.query('BEGIN'); ...; await client.query('COMMIT'); }
 *   catch (e) { await client.query('ROLLBACK'); throw e; }
 *   finally { client.release(); }
 */
export function getClient() {
  return pool.connect();
}

export async function healthcheck() {
  const { rows } = await pool.query('SELECT 1 AS ok');
  return rows[0]?.ok === 1;
}
