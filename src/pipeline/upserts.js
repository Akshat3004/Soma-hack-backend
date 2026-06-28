import { pool } from '../db/pool.js';

// Each upsert is idempotent (ON CONFLICT DO UPDATE) so re-fetching an overlap
// window or replaying the raw landing zone never creates duplicates.
// All return the number of rows written.

export async function upsertPatients(rows) {
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
  return rows.length;
}

export async function upsertDiagnoses(rows) {
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
  return rows.length;
}

export async function upsertCoverage(rows) {
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
  return rows.length;
}

export async function upsertNotes(rows) {
  // API field `patient_id` (integer) maps to DB column `patient_internal_id`.
  for (const n of rows) {
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
  return rows.length;
}

export async function upsertAssessments(rows) {
  // raw_json arrives as a JSON-encoded string; the column is jsonb.
  for (const a of rows) {
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
  return rows.length;
}
