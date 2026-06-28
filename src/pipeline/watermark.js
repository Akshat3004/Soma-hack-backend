import { pool } from '../db/pool.js';

/**
 * Returns the stored high-water mark for a source, or null if never synced.
 * @param {string} source e.g. 'patients'
 * @returns {Promise<Date|null>}
 */
export async function getWatermark(source) {
  const { rows } = await pool.query(
    `SELECT last_api_modified_at FROM sync_state WHERE source_name = $1`,
    [source],
  );
  return rows[0]?.last_api_modified_at ?? null;
}

/**
 * Advances a source's watermark. GUARDRAIL: only ever moves FORWARD
 * (GREATEST), and a null timestamp leaves the existing watermark untouched
 * while still recording a successful sync. Call this only AFTER the run's
 * upserts have committed (commit-then-advance).
 *
 * @param {string} source
 * @param {string|null} tsIso  max last_modified_at actually observed, or null
 */
export async function advanceWatermark(source, tsIso) {
  await pool.query(
    `INSERT INTO sync_state (source_name, last_successful_sync_at, last_api_modified_at, updated_at)
     VALUES ($1, now(), $2, now())
     ON CONFLICT (source_name) DO UPDATE SET
       last_successful_sync_at = now(),
       last_api_modified_at = GREATEST(sync_state.last_api_modified_at, EXCLUDED.last_api_modified_at),
       updated_at = now()`,
    [source, tsIso],
  );
}
