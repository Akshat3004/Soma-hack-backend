// Backwards-compatible entry point. The pipeline now lives in sync.js, which
// adds the raw landing zone, adaptive throttling, circuit breakers, metrics,
// and incremental/reconcile modes. `ingest` == a full sync.
// See docs/RESILIENCE.md.
import { pool } from '../db/pool.js';
import { sync } from './sync.js';

export { sync };

/** Run a full ingestion (every patient + all children). */
export function ingest(opts = {}) {
  return sync({ ...opts, mode: 'full' });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ingest()
    .catch((err) => {
      console.error('Ingestion failed:', err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
