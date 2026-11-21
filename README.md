# Certiflow

## Requirements & Product Decisions

- **Large batches:** Batches with more than 30 candidates require Quality Team approval. Batches of 30 or fewer proceed from district consensus to State Office review.
- **District consensus:** Two distinct district officers from the batch's district must approve. The API serializes decisions with a database row lock; duplicate approval by the same officer does not count twice.
- **Send-back and resubmission:** Resubmitting a `CHANGES_REQUESTED` batch deactivates previous approvals (`isActive = false`). Candidate data may have changed, so prior approvals cannot be carried forward.
- **Demo SLA:** A batch is considered stuck when it remains in a review state for more than 120 seconds. Override this demo threshold with `SLA_THRESHOLD_SECONDS`.

## Architecture & Tech Stack Decisions

- **PostgreSQL and Prisma** hold users, batches, candidates, approvals, certificates, and audit history. Approval transactions use PostgreSQL pessimistic row locking (`SELECT ... FOR UPDATE`) to serialize concurrent decisions on a batch and keep consensus counts consistent.
- **Redis Pub/Sub and SSE** deliver batch, SLA, and certificate events to connected dashboards. Server-Sent Events provide a simple one-way live update stream over HTTP without polling. Each SSE client uses a dedicated Redis subscriber connection.
- **Redis verification cache** avoids repeat database reads for public certificate lookups. Cache entries live for 60 seconds; certificate revocation actively deletes the matching key so a cached valid response is not retained after revocation.
- **BullMQ** manages asynchronous certificate issuance and SLA monitoring. Deterministic issuance `jobId` values make queue submissions idempotent; database unique constraints on `candidateId` and `certificateNumber` prevent duplicate certificates if a job is retried or replayed.
- **React, Vite, and TypeScript** provide a client UI with persona selection, batch operations, certificate verification, and SSE refreshes. The API base URL is configurable through `VITE_API_URL`.

## Local Setup & Test Guide

Prerequisites: Git, Docker with the Compose plugin, and Node.js 20+ with npm.

Clone and start the complete demo stack:

```sh
git clone <repository-url> certiflow
cd certiflow
docker compose up --build
```

Compose starts PostgreSQL, Redis, the API, the background worker, and the Vite web app. The API applies migrations and seeds demo personas before listening. Open:

- Web UI: <http://localhost:5173>
- API: <http://localhost:4000>

Run integration tests from a second terminal while PostgreSQL and Redis are available:

```sh
cd certiflow/backend
npm install
npm test
```

The integration suite reads `backend/.env` when present. For a different test database or Redis instance, set `DATABASE_URL` and `REDIS_URL` in the test shell before `npm test`. Do not point integration tests at production data: the suite creates and deletes test records.

Stop the demo stack with `Ctrl+C`, or from another terminal run:

```sh
docker compose down
```

To also remove persisted demo data:

```sh
docker compose down -v
```

## AI Usage & Known Limitations

GitHub Copilot was used to help implement the Prisma-backed API, workflow routes, issuance/SLA worker, SSE stream, React/Vite dashboard, container setup, and this documentation. The implementation and tests were reviewed against the requirements and current schema. `backend/tests/certiflow.test.ts` uses Supertest against the exported Express app and Prisma assertions against PostgreSQL. It verifies CSV row errors and no-write behavior, concurrent district locking/consensus, unauthorized reviewer and revocation requests, the 35-candidate quality gate, real BullMQ issuance retries and unique certificates, verification cache invalidation after revocation, and approval reset on resubmission. `backend/tests/setup.ts` loads the test environment, while the test hooks seed demo personas, start/stop workers, and remove test-created rows. The API route, persistence, approval, issuance, and verification modules are exercised through these end-to-end flows.

The integration suite must be run with `cd backend && npm test` while its configured PostgreSQL and Redis are available. The SSE transport and periodic SLA scheduler are not directly asserted by this workflow suite and should receive dedicated connection/timer tests before production rollout. Tests have not been executed in every development environment; passing results should be confirmed in the target environment before a release.

Known demo limitations:

- Certificate creation models the issuance record, but PDF generation and secure document storage are not implemented.
- WhatsApp delivery is simulated with a random failure; there is no real messaging provider integration or production delivery receipt.
- The persona selector sends a demo `x-user-id` header. It is not authentication; production must use OAuth/OIDC or another secure identity provider and enforce authorization server-side.
- The demo uses a single Redis instance and a local PostgreSQL Compose volume. Production availability, backups, network security, and scaling are covered in [DEPLOYMENT.md](./DEPLOYMENT.md).
- The UI is optimized for the demo workflow and does not yet include pagination, advanced search, or accessibility/usability testing across all assistive technologies.
