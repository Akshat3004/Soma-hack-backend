import { pool } from '../db/pool.js';
import { pccRequest } from './pccClient.js';
import { landRaw } from './rawStore.js';
import { metrics } from './metrics.js';
import { getWatermark, advanceWatermark } from './watermark.js';
import {
  upsertPatients, upsertDiagnoses, upsertCoverage, upsertNotes, upsertAssessments,
} from './upserts.js';

const FACILITY_IDS = [101, 102, 103];
const DEFAULT_CONCURRENCY = 12; // the AdaptiveLimiter is the real throttle
const OVERLAP_MS = 5 * 60 * 1000; // re-fetch a 5-min overlap to dodge boundary races

/** Run async `fn` over `items` with at most `limit` in flight. */
async function mapLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

/** Fetch + land the raw response, then return the parsed body. */
async function fetchLand(path, params) {
  const env = await pccRequest(path, params);
  await landRaw(env);
  return env.json ?? [];
}

/**
 * Parse a timestamp to epoch ms, treating NAIVE strings (no Z / no offset) as
 * UTC. The spite-API sends naive timestamps; without this, `new Date(naive)`
 * uses the local zone and silently skews every comparison and the watermark.
 */
function utcMs(ts) {
  if (!ts) return 0;
  if (typeof ts === 'string' && !/([zZ]|[+-]\d\d:?\d\d)$/.test(ts)) ts = `${ts}Z`;
  const t = new Date(ts).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** Max last_modified_at across a patient batch, as UTC ISO, or null. */
function maxModified(patients) {
  let max = 0;
  for (const p of patients) {
    const t = utcMs(p.last_modified_at);
    if (t > max) max = t;
  }
  return max === 0 ? null : new Date(max).toISOString();
}

/**
 * Of the patients returned by the API, which actually need their child records
 * re-pulled? A patient needs it if it's new to our DB, or its API
 * last_modified_at is strictly newer than what we stored. MUST be called
 * BEFORE upsertPatients, otherwise stored == api.
 */
async function patientsNeedingChildren(patients) {
  if (patients.length === 0) return [];
  const ids = patients.map((p) => p.id);
  const { rows } = await pool.query(
    `SELECT id, last_modified_at FROM patients WHERE id = ANY($1)`,
    [ids],
  );
  const stored = new Map(rows.map((r) => [r.id, utcMs(r.last_modified_at)]));
  return patients.filter((p) => {
    if (!stored.has(p.id)) return true; // new patient
    return utcMs(p.last_modified_at) > stored.get(p.id); // genuinely changed
  });
}

/** Patients we have in a facility that the API no longer returns (silent deletes). */
async function detectMissing(facilityId, apiIds) {
  const { rows } = await pool.query(`SELECT id FROM patients WHERE facility_id = $1`, [facilityId]);
  const apiSet = new Set(apiIds);
  return rows.map((r) => r.id).filter((id) => !apiSet.has(id));
}

async function syncChildren(p, counts) {
  // Children use NO `since` filter on purpose: /diagnoses & /coverage don't
  // support it, and /notes & /assessments filter on the clinical effective_date
  // (not a modified-time), which would silently miss back-dated edits. Once a
  // patient is in the delta, we re-pull all of their children in full.
  const [diagnoses, coverage, notes, assessments] = await Promise.all([
    fetchLand('/pcc/diagnoses', { patient_id: p.patient_id }),
    fetchLand('/pcc/coverage', { patient_id: p.patient_id }),
    fetchLand('/pcc/notes', { patient_id: p.id }),
    fetchLand('/pcc/assessments', { patient_id: p.id }),
  ]);
  counts.diagnoses += await upsertDiagnoses(diagnoses);
  counts.coverage += await upsertCoverage(coverage);
  counts.notes += await upsertNotes(notes);
  counts.assessments += await upsertAssessments(assessments);
}

async function startRun(mode) {
  const { rows } = await pool.query(
    `INSERT INTO sync_runs (mode, started_at, status) VALUES ($1, now(), 'running') RETURNING id`,
    [mode],
  );
  return rows[0].id;
}

async function finishRun(id, status, counts, snap) {
  const upserted = Object.values(counts).reduce((a, b) => a + b, 0);
  await pool.query(
    `UPDATE sync_runs SET finished_at=now(), status=$2, requests=$3, throttled_429=$4,
       errors=$5, records_upserted=$6, detail=$7 WHERE id=$1`,
    [id, status, snap.requests, snap.throttled, snap.errors, upserted,
     JSON.stringify({ counts, byEndpoint: snap.byEndpoint, elapsedMs: snap.elapsedMs })],
  );
}

/**
 * Run a sync.
 *
 * @param {object} opts
 * @param {'full'|'incremental'|'reconcile'} [opts.mode='incremental']
 *   - full:        pull every patient + all children (first load).
 *   - incremental: ask `/patients?since=watermark-ε`; fan out children only for
 *                  the genuinely-changed delta. O(Δ) steady state.
 *   - reconcile:   pull the full `/patients` list (no `since`); fan out children
 *                  for changed patients AND report patients missing upstream.
 * @param {number} [opts.concurrency]
 */
export async function sync({ mode = 'incremental', concurrency = DEFAULT_CONCURRENCY } = {}) {
  metrics.reset();
  const runId = await startRun(mode);
  const counts = { patients: 0, diagnoses: 0, coverage: 0, notes: 0, assessments: 0 };

  try {
    const wm = mode === 'incremental' ? await getWatermark('patients') : null;
    const since = wm ? new Date(new Date(wm).getTime() - OVERLAP_MS).toISOString() : null;
    if (mode === 'incremental') {
      console.log(since ? `Incremental since ${since} (watermark ${wm.toISOString?.() ?? wm} − 5m overlap)` : 'No watermark yet — first run behaves as full.');
    }

    let observedMax = null;
    let delta = [];
    const missing = [];

    for (const facility_id of FACILITY_IDS) {
      const params = since ? { facility_id, since } : { facility_id };
      const patients = await fetchLand('/pcc/patients', params);

      const need = mode === 'full' ? patients : await patientsNeedingChildren(patients);
      await upsertPatients(patients);
      counts.patients += patients.length;
      delta = delta.concat(need);

      const mx = maxModified(patients);
      if (mx && (observedMax === null || mx > observedMax)) observedMax = mx;

      if (mode === 'reconcile') {
        missing.push(...(await detectMissing(facility_id, patients.map((p) => p.id))));
      }
      console.log(`  facility ${facility_id}: ${patients.length} returned, ${need.length} need children`);
    }

    console.log(`Fetching children for ${delta.length} patient(s)...`);
    await mapLimit(delta, concurrency, (p) => syncChildren(p, counts));

    // GUARDRAIL: commit-then-advance — only move the watermark now that every
    // upsert above has succeeded.
    if (observedMax) await advanceWatermark('patients', observedMax);
    await Promise.all(
      ['diagnoses', 'coverage', 'notes', 'assessments'].map((s) => advanceWatermark(s, null)),
    );

    const snap = metrics.snapshot();
    await finishRun(runId, 'success', counts, snap);

    if (mode === 'reconcile' && missing.length) {
      console.warn(`⚠️  ${missing.length} patient(s) in DB no longer returned by API (possible upstream deletes): ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? '…' : ''}`);
    }

    console.log(`\n✅ ${mode} sync complete in ${(snap.elapsedMs / 1000).toFixed(1)}s — ${snap.requests} ok, ${snap.throttled} throttled (${(snap.throttleRate * 100).toFixed(0)}%), ${snap.errors} errors`);
    console.table(counts);
    return { mode, counts, delta: delta.length, missing, metrics: snap };
  } catch (err) {
    await finishRun(runId, 'failed', counts, metrics.snapshot()).catch(() => {});
    throw err;
  }
}

// CLI: node src/pipeline/sync.js [--mode=full|incremental|reconcile] [--full] [--reconcile]
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let mode = 'incremental';
  for (const a of args) {
    if (a === '--full') mode = 'full';
    else if (a === '--reconcile') mode = 'reconcile';
    else if (a.startsWith('--mode=')) mode = a.split('=')[1];
  }
  sync({ mode })
    .catch((err) => {
      console.error(`${mode} sync failed:`, err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
