# Soma Backend — Resilient Healthcare Data Ingestion

**Node.js · Express 5 · PostgreSQL · GraphQL · Retry/Backoff · Incremental ETL**

Built for the ABI Frameworks Hackathon, this backend ingests **synthetic** patient records from a deliberately rate-limited mock electronic-health-record API. It stores raw responses for audit/replay, synchronizes typed PostgreSQL tables, and exposes basic health endpoints.

> **What is implemented:** a resilient ingestion and synchronization subsystem. The original challenge also asked for wound extraction, Medicare Part B eligibility classification and a billing dashboard. **Those features are not implemented in this repository.** The present GraphQL API has health queries only. This is not a clinical service.

## Features verified in the source

| Capability | Implementation |
| --- | --- |
| HTTP 429 handling | Respects Retry-After; retries with a configurable retry budget |
| Transient failure handling | Exponential backoff with jitter for 5xx/network failures |
| Adaptive concurrency | AIMD limiter increases on success and halves on throttling |
| Circuit breakers | Per-endpoint hard-failure threshold and recovery cooldown |
| Raw landing zone | Stores the request envelope and JSON payload in PostgreSQL before typed upserts |
| Idempotent writes | ON CONFLICT UPDATE for patients, diagnoses, insurance coverage, notes and assessments |
| Incremental sync | Five-minute overlapping watermark; changed patients get complete child refresh |
| Reconciliation | Compares full upstream patient IDs with local rows to flag possible deletions |
| Observability | Sync-run metrics for requests, errors, throttling and records written |

## Architecture

~~~mermaid
flowchart LR
    A[Mock PCC API] --> B[Adaptive limiter / retries / circuit breakers]
    B --> C[Raw API responses in PostgreSQL]
    C --> D[Typed idempotent upserts]
    S[Full / incremental / reconcile sync] --> B
    D --> DB[(PostgreSQL)]
    DB --> W[Watermarks + sync-run metrics]
    W --> S
    DB --> H[Express + GraphQL health endpoints]
~~~

**Key engineering decisions:** the patient watermark only advances after successful writes; re-fetching a five-minute overlap protects boundary changes; child records are re-fetched in full because some source endpoints use clinical effective dates rather than modification timestamps. See [docs/RESILIENCE.md](docs/RESILIENCE.md).

## Running locally

Requires Node.js 20–22, PostgreSQL, and a reachable upstream mock API. This repository **does not include an offline mock EHR server**.

~~~bash
git clone https://github.com/Akshat3004/Soma-hack-backend.git
cd Soma-hack-backend
npm ci
cp .env.example .env
# Set DATABASE_URL for your local PostgreSQL; adjust PGSSL as needed.
npm run db:migrate
npm run ingest      # full ingestion, potentially many upstream calls and retries
npm start
~~~

Follow-up jobs:

~~~bash
npm run sync       # incremental sync
npm run reconcile  # compare full upstream patient roster
npm test           # offline unit tests for concurrency and circuit breakers
~~~

The migration runner applies both core tables and resilience tables in lexical order. The older db:init script reads an unrelated placeholder schema; **use db:migrate for fresh installations**. Review the new schema migration carefully before using an existing persistent database.

## Routes currently provided

| Endpoint | Current behavior |
| --- | --- |
| GET / | Service metadata and route list |
| GET /health | Returns service status and database-connection boolean |
| POST /graphql | Health queries _health and _dbHealth |

~~~bash
curl http://localhost:4000/health
curl -X POST http://localhost:4000/graphql -H 'Content-Type: application/json' -d '{"query":"{ _health _dbHealth }"}'
~~~

Note: /health returns HTTP 200 even if the database check is false; inspect the db value.

## Explore the source

- [src/pipeline/pccClient.js](src/pipeline/pccClient.js) — resilient upstream HTTP client
- [src/pipeline/adaptiveLimiter.js](src/pipeline/adaptiveLimiter.js) — AIMD limiter and circuit breakers
- [src/pipeline/sync.js](src/pipeline/sync.js) — full, incremental and reconciliation orchestration
- [src/pipeline/upserts.js](src/pipeline/upserts.js) — idempotent PostgreSQL writes
- [src/db/migrations/](src/db/migrations/) — database schema
- [src/app.js](src/app.js) — Express and Apollo health endpoints
- [docs/RESILIENCE.md](docs/RESILIENCE.md) — design and edge-case analysis
- [docs/HACKATHON_BRIEF.md](docs/HACKATHON_BRIEF.md) — preserved original problem statement
- [API.md](API.md) — mock API specifications

## Verification and limitations

The upstream challenge describes **300 synthetic patients across three facilities**, not a performance result measured by this project. Repository code contains the functionality above; full ingestion and live deployment have **not been rerun as part of this documentation update**.

Node's built-in test runner verifies limiter behavior and breaker transitions without depending on the remote service. There is currently no full integration/throughput test, and wound extraction, patient eligibility queries and billing UI are not implemented. A Render deployment blueprint exists, but does not establish that a live endpoint is currently online.

For production, strengthen database TLS verification (the existing PGSSL option accepts certificates without verification), add authorization before exposing patient-level data, and use a dedicated external database.

## Next engineering milestones

1. Build a deterministic mock upstream server and integration tests for 429 responses, recovery and watermark behavior.
2. Introduce authorized GraphQL queries for persisted data.
3. Implement extraction and human-review routing for the synthetic wound-care challenge.
4. Publish reproducible run metrics and deployment screenshots instead of estimated performance.
