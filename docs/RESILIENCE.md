# Resilience & Sync Layer

How this backend pulls reliably from a hostile, rate-limited, deliberately-uncooperative upstream API — and never has to depend on it again once data is loaded.

> Scope: this doc covers **only** the ingestion/resilience subsystem under
> [`src/pipeline/`](../src/pipeline) plus its two tables. The GraphQL/Express
> API is documented elsewhere.

---

## Philosophy

**Treat the upstream API as adversarial input.** We don't trust its uptime, throughput, schema, types, ordering, or completeness. The strategy is:

1. **Pay the API tax once.** Land every response verbatim in our own Postgres.
2. **Transform from our DB, not the wire.** Schema changes or parser bugs never cost another API call.
3. **In steady state, poke gently.** Only fetch what changed, gated on a trustworthy watermark.

The result: sync cost tracks **churn (Δ)**, not dataset size (N).

---

## Architecture

```
        ┌─────────────────────────────────────────────────────────┐
        │                      sync.js (runner)                     │
        │   modes: full | incremental | reconcile                   │
        └───────────────┬───────────────────────────┬──────────────┘
                        │                            │
         pccRequest()   │                            │  upserts.js
                        ▼                            ▼
  ┌───────────────────────────────┐      ┌────────────────────────┐
  │        pccClient.js           │      │   typed tables         │
  │  • adaptive concurrency (AIMD)│      │   patients, diagnoses, │
  │  • per-endpoint circuit breaker      │   coverage, notes,     │
  │  • 429 Retry-After + backoff  │      │   assessments          │
  │  • metrics on every request   │      └────────────────────────┘
  └───────────────┬───────────────┘                ▲
                  │ envelope {status,json,raw,…}    │ transform
                  ▼                                 │
        ┌──────────────────────┐          ┌─────────────────────┐
        │  rawStore.landRaw()  │─────────▶│  raw_api_responses  │  ← replay/audit
        └──────────────────────┘          └─────────────────────┘

  watermark.js → sync_state      metrics.js → sync_runs
```

Every fetch goes `pccRequest → land raw → transform/upsert`. The raw landing happens **before** any parsing.

---

## Components

### 1. Raw landing zone — [`rawStore.js`](../src/pipeline/rawStore.js) → `raw_api_responses`

Every response (endpoint, params, status, body, attempt count, latency) is stored as `jsonb` before transform. This is the **replay and audit layer**: re-derive typed tables from here without re-hitting the API, and keep the receipt when the API misbehaves.

### 2. Adaptive concurrency (AIMD) — [`adaptiveLimiter.js`](../src/pipeline/adaptiveLimiter.js)

The TCP-congestion trick applied to HTTP. The shared `limiter` gates how many requests are in flight and **auto-tunes** the ceiling:

| Event | Reaction |
|---|---|
| success | additive increase (`limit += 0.5`) |
| 429 / 5xx / network | multiplicative decrease (`limit /= 2`) |

It finds the API's real throughput instead of you hard-coding a concurrency number.

### 3. Circuit breakers — [`adaptiveLimiter.js`](../src/pipeline/adaptiveLimiter.js)

One breaker **per endpoint**. After `threshold` consecutive **hard** failures (5xx / network — *not* 429, which is expected throttling) it trips **open**, fails fast for a cooldown, then half-opens to probe recovery. Stops one sick endpoint from stalling the whole run.

### 4. Retry policy — [`pccClient.js`](../src/pipeline/pccClient.js)

| Response | Behavior |
|---|---|
| **429** | wait `Retry-After` seconds (server-dictated) → AIMD decrease → retry |
| **5xx / network** | exponential backoff + jitter (cap 8s) → AIMD decrease → breaker++ → retry |
| **other 4xx** (422) | throw immediately — retrying a bad request is pointless |
| **200 non-JSON** | throw, but raw text is still captured |

### 5. Observability — [`metrics.js`](../src/pipeline/metrics.js) → `sync_runs`

In-memory counters (requests / throttled / errors, per-endpoint latency) are reset per run and persisted to `sync_runs` at the end — so you can **prove** the upstream's behavior over time.

### 6. Watermark sync — [`watermark.js`](../src/pipeline/watermark.js) + [`sync.js`](../src/pipeline/sync.js) → `sync_state`

Per-source high-water marks drive incremental fetching (below).

---

## Sync modes

Run via CLI or the exported `sync({ mode })`.

| Mode | What it does | Steady-state cost | When |
|---|---|---|---|
| **full** | every patient + all children | ~1,200 calls | first load / disaster recovery |
| **incremental** | `/patients?since=watermark−ε`; fan out children only for the genuinely-changed delta | **3 calls** if nothing changed; `3 + 4·Δ` otherwise | routine, frequent (cron) |
| **reconcile** | full `/patients` (no `since`); fan out children for changed patients **and** report patients missing upstream | ~3 + 4·Δ + drift | periodic safety net (e.g. nightly) |

**Cheap-often (incremental) + thorough-occasionally (reconcile)** is the recommended cadence.

```bash
npm run db:migrate     # create raw_api_responses + sync_runs (idempotent)
npm run ingest         # full load
npm run sync           # incremental
npm run reconcile      # full-list reconcile + missing-row report
# or: node src/pipeline/sync.js --mode=incremental
```

---

## Guardrails (the edge cases that break naive watermark sync)

These are baked into the code; each maps to a real failure mode on this API.

| Guardrail | Where | Problem it prevents |
|---|---|---|
| **Naive timestamps → UTC** | `utcMs()` in [sync.js](../src/pipeline/sync.js) + `timezone=UTC` on the pool in [pool.js](../src/db/pool.js) | API sends `2026-05-17T20:15:00` (no offset). `new Date(naive)` parses as **local** time, skewing the watermark and causing false-positive "changed" detection. *(This was a real bug caught during testing — a patient was wrongly re-fetched every run and the watermark drifted +4h.)* |
| **Overlap window (`since − 5min`)** | `OVERLAP_MS` in sync.js | Two records sharing the boundary timestamp; one slips through. We re-fetch a small overlap; upserts make the dups free. |
| **Commit-then-advance** | end of `sync()` | Crash mid-fan-out after bumping the watermark = records skipped forever. The watermark advances **only after** all upserts commit. |
| **Watermark only moves forward** | `GREATEST(...)` in [watermark.js](../src/pipeline/watermark.js) | A late/out-of-order batch can't roll the watermark backward. |
| **Per-source watermarks** | `sync_state.source_name` PK | One global mark would advance past a slower source and skip its records. |
| **Children fetched in full, no `since`** | `syncChildren()` | `/diagnoses` & `/coverage` have no `since`; `/notes` & `/assessments` filter on the **clinical `effective_date`**, not a modified-time — so back-dated edits are invisible to `since`. Once a patient is in the delta we re-pull all its children. |
| **Idempotent upserts** | [upserts.js](../src/pipeline/upserts.js) | Overlap re-fetches and raw replays never create duplicates (`ON CONFLICT DO UPDATE`). |
| **Reconcile detects deletes** | `detectMissing()` | `since` never reports deletions; reconcile diffs the full set and flags rows the API no longer returns. |

---

## Schema additions

```sql
raw_api_responses(id, source_name, endpoint, params jsonb, http_status,
                  body jsonb, record_count, attempts, duration_ms, fetched_at)

sync_runs(id, mode, started_at, finished_at, status,
          requests, throttled_429, errors, records_upserted, detail jsonb)
```

`sync_state` (pre-existing) holds the per-source watermarks:
`source_name, last_successful_sync_at, last_api_modified_at, updated_at`.

DDL lives in [`src/db/migrations/001_resilience.sql`](../src/db/migrations/001_resilience.sql); apply with `npm run db:migrate`.

---

## Observability queries

```sql
-- Recent runs and their throttle/error tallies
SELECT id, mode, status, requests, throttled_429, errors, records_upserted,
       round(extract(epoch FROM finished_at - started_at)) AS secs
FROM sync_runs ORDER BY id DESC LIMIT 20;

-- Throttle rate per endpoint (proving the spite-API's behavior)
SELECT endpoint,
       count(*)                                  AS calls,
       round(avg(duration_ms))                   AS avg_ms,
       round(avg(attempts), 2)                   AS avg_attempts
FROM raw_api_responses GROUP BY endpoint ORDER BY avg_attempts DESC;

-- Replay: re-derive a patient's latest assessment straight from raw
SELECT body FROM raw_api_responses
WHERE endpoint = '/pcc/assessments' AND params->>'patient_id' = '214'
ORDER BY fetched_at DESC LIMIT 1;
```

---

## Config knobs

| Knob | Location | Default |
|---|---|---|
| Adaptive limiter `{min,max,start,stepUp}` | `new AdaptiveLimiter()` in adaptiveLimiter.js | `1 / 16 / 4 / 0.5` |
| Circuit breaker `{threshold,cooldownMs}` | `new CircuitBreaker()` | `5 / 10s` |
| Overlap window | `OVERLAP_MS` in sync.js | 5 min |
| App-level fan-out concurrency | `DEFAULT_CONCURRENCY` in sync.js | 12 |
| Max retries per request | `maxRetries` in pccClient.js | 10 |
| Upstream base URL | `PCC_BASE_URL` env | hackathon API |
