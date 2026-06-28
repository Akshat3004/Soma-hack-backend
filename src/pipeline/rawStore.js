import { pool } from '../db/pool.js';

/**
 * Lands a raw API response envelope into `raw_api_responses` BEFORE transform.
 * This is the replay/audit layer — if the upstream schema changes or a parser
 * has a bug, we re-transform from here instead of re-hitting the API.
 *
 * @param {{status,json,endpoint,params,attempts,durationMs}} env
 */
export async function landRaw(env) {
  const body = env.json;
  const recordCount = Array.isArray(body) ? body.length : body ? 1 : 0;
  await pool.query(
    `INSERT INTO raw_api_responses
       (source_name, endpoint, params, http_status, body, record_count, attempts, duration_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      'pcc',
      env.endpoint,
      JSON.stringify(env.params ?? {}),
      env.status,
      body == null ? null : JSON.stringify(body),
      recordCount,
      env.attempts,
      env.durationMs,
    ],
  );
}
