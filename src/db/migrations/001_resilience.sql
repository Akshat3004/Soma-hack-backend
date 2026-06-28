-- Resilience layer schema (additive — safe to run against the existing DB).
-- See docs/RESILIENCE.md for the full design.

-- 1. Raw landing zone: every API response is stored verbatim BEFORE transform.
--    This is the source of truth we can replay/re-transform without re-hitting
--    the (hostile) upstream API.
CREATE TABLE IF NOT EXISTS raw_api_responses (
  id            BIGSERIAL PRIMARY KEY,
  source_name   TEXT        NOT NULL DEFAULT 'pcc',
  endpoint      TEXT        NOT NULL,
  params        JSONB       NOT NULL DEFAULT '{}',
  http_status   INTEGER     NOT NULL,
  body          JSONB,
  record_count  INTEGER,
  attempts      INTEGER     NOT NULL DEFAULT 1,
  duration_ms   INTEGER,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_raw_endpoint_fetched
  ON raw_api_responses (endpoint, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_raw_params
  ON raw_api_responses USING GIN (params);

-- 2. Persisted observability: one row per sync run with request/throttle/error
--    tallies, so you can prove the spite-API's behavior over time.
CREATE TABLE IF NOT EXISTS sync_runs (
  id               BIGSERIAL PRIMARY KEY,
  mode             TEXT        NOT NULL,          -- full | incremental | reconcile
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ,
  status           TEXT        NOT NULL DEFAULT 'running', -- running | success | failed
  requests         INTEGER     NOT NULL DEFAULT 0,  -- successful 2xx
  throttled_429    INTEGER     NOT NULL DEFAULT 0,
  errors           INTEGER     NOT NULL DEFAULT 0,  -- 5xx / network / hard 4xx
  records_upserted INTEGER     NOT NULL DEFAULT 0,
  detail           JSONB
);
CREATE INDEX IF NOT EXISTS idx_sync_runs_started
  ON sync_runs (started_at DESC);
