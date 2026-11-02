-- Core schema expected by the existing ingestion and watermark code.
-- Safe for fresh development databases. Review against any pre-existing installation.
CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY,
  facility_id INTEGER,
  patient_id TEXT UNIQUE,
  first_name TEXT, last_name TEXT, birth_date DATE, gender TEXT,
  primary_payer_code TEXT, last_modified_at TIMESTAMPTZ,
  is_new_admission BOOLEAN
);
CREATE INDEX IF NOT EXISTS idx_patients_facility ON patients(facility_id);

CREATE TABLE IF NOT EXISTS diagnoses (
  id INTEGER PRIMARY KEY, patient_id TEXT,
  icd10_code TEXT, icd10_description TEXT, clinical_status TEXT,
  onset_date DATE, last_modified_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS coverage (
  id INTEGER PRIMARY KEY, patient_id TEXT,
  payer_name TEXT, payer_code TEXT, payer_type TEXT,
  effective_from TIMESTAMPTZ, effective_to TIMESTAMPTZ,
  last_modified_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS progress_notes (
  id INTEGER PRIMARY KEY, patient_internal_id INTEGER,
  org_id TEXT, pcc_note_id INTEGER, note_type TEXT,
  effective_date TIMESTAMPTZ, note_text TEXT, created_by TEXT,
  note_label TEXT, sync_version INTEGER, is_current BOOLEAN
);
CREATE TABLE IF NOT EXISTS assessments (
  id INTEGER PRIMARY KEY, patient_internal_id INTEGER,
  org_id TEXT, pcc_assessment_id INTEGER, assessment_type TEXT, status TEXT,
  assessment_date DATE, completion_date DATE, template_id INTEGER,
  assessment_type_description TEXT, raw_json JSONB,
  sync_version INTEGER, is_current BOOLEAN
);
CREATE TABLE IF NOT EXISTS sync_state (
  source_name TEXT PRIMARY KEY,
  last_successful_sync_at TIMESTAMPTZ,
  last_api_modified_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
