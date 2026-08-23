# F1 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold the modular monolith foundation — Docker infra, complete DB migrations from `docs/SCHEMA.sql.sql`, RBAC guards, logging, health checks, CI — ending with a green pipeline and a smoke test proving the two partial unique indexes reject duplicate active selections.

**Architecture:** npm-workspaces monorepo where the repo root IS the NestJS API (`src/`), with `workers/` (BullMQ) and `web/` (React 19 + Vite) as workspace members. One TypeScript build emits `dist/src` + `dist/workers`; one Docker image runs either entrypoint. Drizzle uses hand-authored SQL migrations (triggers/partitions are beyond introspection).

**Tech Stack:** Node 22, NestJS 11 (TS strict), PostgreSQL 16 + pgvector (Drizzle), Redis 7 (ioredis), BullMQ, nestjs-pino, @nestjs/terminus, Vitest + Testcontainers, React 19 + Vite + Tailwind 4.

**Spec:** `docs/PRD.md.md`, `docs/AGENTS.md.md`, `docs/SCHEMA.sql.sql`

## Global Constraints
- Node >=22 (engines field; CI runs 22). TS strict mode everywhere.
- Roles: admin / lecturer / student. Student email MUST end in `@ui.ac.id` (env `STUDENT_DOMAINS`, default `ui.ac.id`) — enforced in service layer AND DB trigger.
- Lock TTL 30s = Redis only, no cron. Undo 15s, grace 60s (settings defaults in schema).
- Audit log append-only, monthly partitions, soft deletes on primary entities.
- Modules never import each other; shared code lives in `src/shared/*`.
- Local env has no Docker: Testcontainers/compose verified in GitHub Actions (ubuntu-latest); typecheck/lint/unit tests run locally.
- Times stored UTC (timestamptz), server-authoritative.

---

### Task 1: Repo scaffold (git, workspaces, tsconfig, eslint)

**Files:** Create `package.json`, `tsconfig.base.json`, `tsconfig.json`, `tsconfig.build.json`, `eslint.config.mjs`, `.gitignore`, `.env.example`, `.nvmrc`, rename docs (`AGENTS.md.md`→`AGENTS.md`, etc.), init git.

- Workspaces: `["workers", "web"]`. Root scripts: `dev` (concurrently api/web/workers via tsx/vite), `build`, `typecheck`, `lint`, `test`, `test:unit`, `test:integration`, `migrate`.
- tsconfig.base: strict, ES2022, NodeNext, experimentalDecorators, emitDecoratorMetadata, skipLibCheck, strictPropertyInitialization.
- Commit.

### Task 2: Shared config + logging + global filter

**Files:** Create `src/shared/config/configuration.ts` (+ module), `src/shared/logging/logger.module.ts`, `src/shared/filters/all-exceptions.filter.ts`.

- `configuration.ts`: parses env once — `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `STUDENT_DOMAINS` (csv, default "ui.ac.id"), `PORT`. Exported `appConfig()` for tests.
- Logger: nestjs-pino, redact `req.headers.authorization`, pino-pretty when `NODE_ENV!=='production'`.
- Filter: catches all exceptions → `{statusCode, message, path, timestamp, requestId}` JSON; HttpException passes its status/message; unknown → 500 logged with stack.
- **Test (unit):** filter maps unknown error→500 shape; HttpException preserved.

### Task 3: Drizzle schema + full migration SQL (SCHEMA.sql expanded)

**Files:** Create `drizzle.config.ts`, `src/shared/db/schema.ts`, `drizzle/0000_init.sql`, `drizzle/meta/_journal.json`, `src/shared/db/db.module.ts`, `src/shared/db/migrate.ts`, `src/shared/db/migrate-cli.ts`.

Migration SQL must include, verbatim-in-spirit from SCHEMA.sql:
1. `CREATE EXTENSION IF NOT EXISTS vector;`
2. All tables: users, students, lecturers, selection_periods, theses, period_enrollments, thesis_selections, swap_requests, thesis_watchers, integrity_flags, activity_logs, support_tickets, notification_deliveries; sequence `ref_number_seq`.
3. CHECK constraints on every enum-ish column exactly as SCHEMA.
4. Partial unique indexes: `one_active_per_thesis(thesis_id)` and `one_active_per_priority(student_id, period_id, priority)` both `WHERE status IN ('locked','confirmed','taken','swap_requested','released_pending') AND deleted_at IS NULL`; plus `idx_theses_period ON theses(period_id) WHERE deleted_at IS NULL`; unique `(period_id, student_id)` on enrollments; unique `(student_id, thesis_id)` on watchers.
5. Trigger fn `check_student_email_domain()` + trigger on `users` BEFORE INSERT OR UPDATE FOR EACH ROW WHEN (NEW.role = 'student') raising on non-matching domain regex.
6. `activity_logs PARTITION BY RANGE (created_at)`, PK `(id, created_at)`, helper `ensure_activity_log_partition(month date)` creating `activity_logs_YYYY_MM` if absent; migration calls it for current month through +5.
7. updated_at triggers? SCHEMA relies on app layer — skip DB triggers there (YAGNI), Drizzle sets it.

Schema TS mirrors all tables incl. pg `vector(1536)` and `inet` columns for later features.

**Interfaces produced:** `DbModule` exports `DATABASE` token (`NodePgDatabase`), `migrate(database)` helper reused by CLI + integration tests.

- **Step:** write files; `npm run typecheck`.
- Integration test (Task 6) proves it against real Postgres.

### Task 4: Identity/RBAC (guards, login, student-email validation)

**Files:** Create `src/modules/identity/{identity.module.ts, auth.controller.ts, auth.service.ts, users.service.ts, student-email.service.ts, guards/jwt-auth.guard.ts, guards/roles.guard.ts, decorators/roles.decorator.ts, decorators/public.decorator.ts}`.

- `JwtAuthGuard` global (APP_GUARD): verifies HS256 JWT `{sub, role}`; honors `@Public()`.
- `RolesGuard`: reads `@Roles(...roles)` metadata; denies when role not included.
- `AuthService.login(email, password)`: argon2id verify vs `users.password_hash`, role in (admin, lecturer); returns access token. `UsersService.create` hashes argon2id.
- `StudentEmailService.assertValidStudentEmail(email)`: must match `/@(${domains})$/` from STUDENT_DOMAINS. Used by F2 import; unit-tested now.
- Health controller `GET /health` (@Public): Terminus pg + redis indicators.
- **Tests (unit):** RolesGuard allow/deny; StudentEmail accept/reject/custom domains; AuthService rejects bad password.

### Task 5: Workers scaffold (BullMQ harness)

**Files:** Create `workers/src/queues.ts` (queue names: email, embedding, export, expiry_events + `createQueueEventsConnection()`), `workers/src/index.ts` (boots Workers from processors registry, graceful SIGTERM), `workers/src/index.test.ts`.

Registry starts empty (processors land in F3+); test asserts queue-name registry matches AGENTS list and harness constructs without throwing (mocked connection).

### Task 6: Web scaffold

**Files:** Create `web/package.json`, `web/vite.config.ts` (+ `/health` proxy to :3000), `web/tsconfig.json`, `web/index.html`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/index.css` (Tailwind 4 via `@tailwindcss/vite`).

App renders API health status (fetch `/health`). Vite react plugin, react 19.

### Task 7: Integration tests (Testcontainers) — partial-index smoke proof

**Files:** Create `test/helpers/spin-postgres.ts`, `test/integration/db-constraints.test.ts`, `vitest.integration.config.ts`.

Spin `pgvector/pgvector:pg16`, run `migrate()`, then:
1. Student user insert OK with `@ui.ac.id`; `gmail.com` rejected by trigger (code 23514/P0001).
2. Guard 1: two active selections same thesis → unique violation; after setting first to `expired`, second inserts fine.
3. Guard 2: same (student, period, priority) active dup → violation; different priority OK; `deleted_at` row doesn't block reinsert.
4. Partition helper: `ensure_activity_log_partition('2027-03-01')` creates partition; activity log insert succeeds.
5. Redis container ping (health-indicator sanity).

### Task 8: Docker (compose + image) 

**Files:** Create `Dockerfile` (multi-stage node:22-slim; build → dist+prod node_modules; CMD migrate-cli && main.js), `docker-compose.yml` (postgres=pgvector/pgvector:pg16 w/ healthcheck+volume, redis:7-alpine w/ healthcheck, api, worker override command), adjust `.env.example`.

### Task 9: CI

**Files:** Create `.github/workflows/ci.yml`. Jobs: (a) node22: install → `typecheck` → `lint` → `test:unit`; (b) integration: Testcontainers job running `test:integration`; (c) compose-smoke: `docker compose up -d --wait`, curl `/health` until 200, assert `{"status":"ok"}`, down. All jobs on push/PR to main.

### Task 10: Local verification + commits

Run locally: install, typecheck, lint, unit tests green. Git log clean (commit per task). Report what only CI can prove (compose, containers).
