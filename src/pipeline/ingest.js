import { pool } from '../db/pool.js';
import { pccGet } from './pccClient.js';

const FACILITY_IDS = [101, 102, 103];

/** Run async `fn` over `items` with at most `limit` in flight at once. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---- Upserts -------------------------------------------------------------

async function upsertPatients(rows) {
  for (const p of rows) {
    await pool.query(
      `INSERT INTO patients (id, facility_id, patient_id, first_name, last_name,
         birth_date, gender, primary_payer_code, last_modified_at, is_new_admission)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         facility_id=EXCLUDED.facility_id, patient_id=EXCLUDED.patient_id,
         first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name,
         birth_date=EXCLUDED.birth_date, gender=EXCLUDED.gender,
         primary_payer_code=EXCLUDED.primary_payer_code,
         last_modified_at=EXCLUDED.last_modified_at,
         is_new_admission=EXCLUDED.is_new_admission`,
      [p.id, p.facility_id, p.patient_id, p.first_name, p.last_name, p.birth_date,
       p.gender, p.primary_payer_code, p.last_modified_at, p.is_new_admission],
    );
  }
}

async function upsertDiagnoses(rows) {
  for (const d of rows) {
    await pool.query(
      `INSERT INTO diagnoses (id, patient_id, icd10_code, icd10_description,
         clinical_status, onset_date, last_modified_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         patient_id=EXCLUDED.patient_id, icd10_code=EXCLUDED.icd10_code,
         icd10_description=EXCLUDED.icd10_description,
         clinical_status=EXCLUDED.clinical_status, onset_date=EXCLUDED.onset_date,
         last_modified_at=EXCLUDED.last_modified_at`,
      [d.id, d.patient_id, d.icd10_code, d.icd10_description, d.clinical_status,
       d.onset_date, d.last_modified_at],
    );
  }
}

async function upsertCoverage(rows) {
  for (const c of rows) {
    await pool.query(
      `INSERT INTO coverage (id, patient_id, payer_name, payer_code, payer_type,
         effective_from, effective_to, last_modified_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET
         patient_id=EXCLUDED.patient_id, payer_name=EXCLUDED.payer_name,
         payer_code=EXCLUDED.payer_code, payer_type=EXCLUDED.payer_type,
         effective_from=EXCLUDED.effective_from, effective_to=EXCLUDED.effective_to,
         last_modified_at=EXCLUDED.last_modified_at`,
      [c.id, c.patient_id, c.payer_name, c.payer_code, c.payer_type,
       c.effective_from, c.effective_to, c.last_modified_at],
    );
  }
}

async function upsertNotes(rows) {
  for (const n of rows) {
    // API field `patient_id` (integer) maps to DB column `patient_internal_id`.
    await pool.query(
      `INSERT INTO progress_notes (id, patient_internal_id, org_id, pcc_note_id,
         note_type, effective_date, note_text, created_by, note_label,
         sync_version, is_current)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET
         patient_internal_id=EXCLUDED.patient_internal_id, org_id=EXCLUDED.org_id,
         pcc_note_id=EXCLUDED.pcc_note_id, note_type=EXCLUDED.note_type,
         effective_date=EXCLUDED.effective_date, note_text=EXCLUDED.note_text,
         created_by=EXCLUDED.created_by, note_label=EXCLUDED.note_label,
         sync_version=EXCLUDED.sync_version, is_current=EXCLUDED.is_current`,
      [n.id, n.patient_id, n.org_id, n.pcc_note_id, n.note_type, n.effective_date,
       n.note_text, n.created_by, n.note_label, n.sync_version, n.is_current],
    );
  }
}

async function upsertAssessments(rows) {
  for (const a of rows) {
    // raw_json arrives as a JSON-encoded string; the column is jsonb.
    await pool.query(
      `INSERT INTO assessments (id, patient_internal_id, org_id, pcc_assessment_id,
         assessment_type, status, assessment_date, completion_date, template_id,
         assessment_type_description, raw_json, sync_version, is_current)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO UPDATE SET
         patient_internal_id=EXCLUDED.patient_internal_id, org_id=EXCLUDED.org_id,
         pcc_assessment_id=EXCLUDED.pcc_assessment_id,
         assessment_type=EXCLUDED.assessment_type, status=EXCLUDED.status,
         assessment_date=EXCLUDED.assessment_date,
         completion_date=EXCLUDED.completion_date, template_id=EXCLUDED.template_id,
         assessment_type_description=EXCLUDED.assessment_type_description,
         raw_json=EXCLUDED.raw_json, sync_version=EXCLUDED.sync_version,
         is_current=EXCLUDED.is_current`,
      [a.id, a.patient_id, a.org_id, a.pcc_assessment_id, a.assessment_type, a.status,
       a.assessment_date, a.completion_date, a.template_id,
       a.assessment_type_description, a.raw_json ?? null, a.sync_version, a.is_current],
    );
  }
}

async function recordSync(sourceName, lastApiModifiedAt) {
  await pool.query(
    `INSERT INTO sync_state (source_name, last_successful_sync_at, last_api_modified_at, updated_at)
     VALUES ($1, now(), $2, now())
     ON CONFLICT (source_name) DO UPDATE SET
       last_successful_sync_at=now(),
       last_api_modified_at=GREATEST(sync_state.last_api_modified_at, EXCLUDED.last_api_modified_at),
       updated_at=now()`,
    [sourceName, lastApiModifiedAt],
  );
}

// ---- Main ----------------------------------------------------------------

export async function ingest({ concurrency = 8 } = {}) {
  const startedAt = Date.now();
  const counts = { patients: 0, diagnoses: 0, coverage: 0, notes: 0, assessments: 0 };
  let maxModified = null;

  // 1. Patients for every facility.
  let allPatients = [];
  for (const facility_id of FACILITY_IDS) {
    const patients = await pccGet('/pcc/patients', { facility_id });
    await upsertPatients(patients);
    counts.patients += patients.length;
    allPatients = allPatients.concat(patients);
    for (const p of patients) {
      if (p.last_modified_at && (!maxModified || p.last_modified_at > maxModified)) {
        maxModified = p.last_modified_at;
      }
    }
    console.log(`  facility ${facility_id}: ${patients.length} patients`);
  }
  await recordSync('patients', maxModified);
  console.log(`Patients loaded: ${counts.patients}. Fetching clinical records...`);

  // 2. Per-patient diagnoses, coverage, notes, assessments (parallel, bounded).
  let done = 0;
  await mapLimit(allPatients, concurrency, async (p) => {
    const [diagnoses, coverage, notes, assessments] = await Promise.all([
      pccGet('/pcc/diagnoses', { patient_id: p.patient_id }),
      pccGet('/pcc/coverage', { patient_id: p.patient_id }),
      pccGet('/pcc/notes', { patient_id: p.id }),
      pccGet('/pcc/assessments', { patient_id: p.id }),
    ]);

    await upsertDiagnoses(diagnoses);
    await upsertCoverage(coverage);
    await upsertNotes(notes);
    await upsertAssessments(assessments);

    counts.diagnoses += diagnoses.length;
    counts.coverage += coverage.length;
    counts.notes += notes.length;
    counts.assessments += assessments.length;

    if (++done % 25 === 0 || done === allPatients.length) {
      console.log(`  processed ${done}/${allPatients.length} patients`);
    }
  });

  await Promise.all([
    recordSync('diagnoses', null),
    recordSync('coverage', null),
    recordSync('notes', null),
    recordSync('assessments', null),
  ]);

  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n✅ Ingestion complete in ${secs}s`);
  console.table(counts);
  return counts;
}

// Allow running directly: `node src/pipeline/ingest.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  ingest()
    .catch((err) => {
      console.error('Ingestion failed:', err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
