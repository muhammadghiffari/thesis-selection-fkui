# Free Render Demo Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing thesis-selection app demonstrable through a public, free-tier Render URL, while keeping the public security/control review green: no public student self-registration, clean fallback errors, validation, CORS/throttling, password reset rules, indexes, alerts, rollback, bot controls, and end-to-end smoke checks.

**Architecture:** Existing NestJS API + React SPA stays same-origin in one Render free web service. Render has no free worker service, so API and BullMQ workers run in the same service. Core state goes to Neon Postgres, queues/lock/pubsub go to Upstash Redis (TLS URL).

**Tech Stack:** Node 22, NestJS 11, React 19, TypeScript strict, Drizzle Postgres, BullMQ, Upstash Redis, Neon Postgres, Render free web service.

**Spec:** `docs/superpowers/specs/2026-11-21-free-public-demo-design.md`

**Existing uncommitted work:** The workspace branch already has substantial uncommitted changes. New implementation must not overwrite or repair all of it. New files/edits should be scoped to this plan; unrelated local diffs stay untouched.

**User-owned deployment credentials:** The user must create/connect a Render GitHub account, create linked services, and inject secrets through the Render dashboard. Never ask for secrets in chat or commit them.

## Global Constraints

- Do not change business rules: title secrecy, exactly-3 selection, role boundaries, schedule/grace rules, swap/revoke rules, integrity signals, audit requirements.
- Student accounts are admin-provisioned/enrolled only. Public/self-registration routes are removed or disabled by this plan. Tests must assert non-student login is unavailable and register stays closed.
- Demo changes persist like the real product; do not add public reset/clone flows for students or erase user selections. Repeat flows with admin-created cloned periods and new identities.
- Error fallback coverage applies to app-reachable error classes: 400, 401, 403, 404, 409, 410, 422, 429, 500; no new 402 billing page because no payment flow exists.
- Input validation remains fail-closed (class-validator + sanitize), sanitized values must not become trusted bypasses.
- CORS is allowlist-only; rejected browser/non-browser origin paths must fail closed. Avoid reporting full credentials/CORS bug logs.
- Rate limiting is app-Redis by default, plus documented platform-edge caps for production. Free Render does not expose their LB config, so Redis/app limits are the enforced layer here.
- Anti-crawler policy: `/api/*` returns clean 403 for known AI/scraper UA (existing botGuard is retained). Public SPA-visible surface should also be verifiable: AI bots crawling SPA should be blocked or indexed minimized per existing/public assets policy.
- Worker startup and shutdown: API+workers share one service; on graceful shutdown, workers close, notify worker supervisor, and exit non-zero if sibling API dies or vice versa. Tests must cover launcher shutdown behavior.
- Worker email: uses production email provider path (Resend when configured). Stub providers must not be the only/effective path in demos. Worker lifecycle should not claim email is delivered if Redis sleeps or delivery retries fail.
- Logging/alerts: prod-level request ID, sensitive redaction, 5xx/auth/integrity alerts; alerts work over webhook when configured; logs never include secrets/tokens.
- Deployment persistence: use Neon/Upstash; Postgres export artifacts are allowed but not required. If added, all new export paths and storage assumptions must be verified and backfilled with a safe fallback.
- All native platform limits must be verified for Neon free/Upstash free: connection/blocking-command compatibility, pool sizes, connection URL format, termination behavior.
- All existing changes in the workspace are potential user work. Inspect before editing and don't stack on fragile assumptions.
- Tests: run `npm run typecheck`, `npm run lint`, `npm run test:unit`, relevant integration tests where dependencies allow; document known-failing environment tests rather than hiding them.

## Review Focus

- Malicious or malformed input paths, including CORS, registration, auth, and validation.
- Sleep/restart behavior of API+workers, worker lifecycle, job delivery, memory/OOM on limited free workers.
- Public accessibility and anti-bot/crawler behavior of SPA and API.
- Confidentiality of thesis titles, student PII, tokens, secrets, and non-requested data.
- Race conditions, locks, quota exhaustion, and security side channels not covered by existing product flows.

---

### Task 1: Demo access closure and bootstrap readiness

**Files:**
- Modify: `src/modules/identity/auth.controller.ts`
- Modify: `src/modules/identity/auth.service.ts`
- Modify: `src/modules/identity/dto.ts`
- Modify: `src/modules/identity/student-email.service.ts` (if unused after closure)
- Test: `test/integration/auth-flow.test.ts`
- Test: `test/integration/security-hardening.test.ts`

**Steps:**
1. Write integration tests proving `/auth/register` is disabled/closed and that unauthorized paths cannot log in students: seed an existing student user/rows, assert POST `/api/auth/register` is unavailable for student creation; assert normal password login stays unavailable for students (401).
2. Run tests to confirm current setup fails/registers.
3. Remove the public student-registration API or make it return 404/403 in the documented demo mode; remove/neutralize user-facing registration links. Keep `@ui.ac.id` domain enforcement for any admin/import flows, and delete code no longer needed.
4. Run typecheck, lint, and updated integration tests; report changed statuses and any test harness assumptions broken.
5. Document in `DEPLOY.md`: only admin/lecturer provisioning remains; students must be imported/enrolled and receive scheduled magic links per product rules.

---

### Task 2: Runtime supervisor for shared API+BullMQ process

**Files:**
- Create: `src/shared/runtime/worker-lifecycle.ts`
- Modify: `workers/src/main.ts`
- Modify: `workers/src/index.ts`
- Test: `test/unit/worker-lifecycle.test.ts`
- Test: `workers/src/index.test.ts` (if needed for worker shutdown)

**Steps:**
1. Write unit tests around a supervisor: "starts all registered workers and API"; "closes workers and notifies on sibling exit"; "non-zero exit code wins over parent". Use dependency injection/mock Worker to keep tests fast and avoid real Redis/DB.
2. Run tests to see failures.
3. Implement worker factory returning processor + `shutdown` in a shared module; update processor factories as needed to expose cleanup (email, expiry, export). Keep dependency behavior identical (still uses PRODUCTION email provider, real DB).
4. Add `bootWorkersInProcess(...)` or equivalent in API entrypoint (`src/main.ts`) after startup; call `onApplicationShutdown`-style graceful close. Add shared Redis client helpers if needed for ioredis.
5. Run typecheck, lint, unit tests, then API + worker-focused integration checks (`npm run test:integration -- auth-flow magic-links support-chat` style as available).

---

### Task 3: Demo deployment configuration and compile checks

**Files:**
- Create: `render.yaml`
- Modify: `Dockerfile`
- Test: `test/integration/deploy-config.test.ts` (structure/config tests without cloud mutation)
- Test: `npm run build`, `npm run typecheck`, `npm run lint`

**Steps:**
1. Write/edit structural tests: blueprints use free web service; Postgres is Neon; Redis is Upstash; plan/env values are variables not hardcoded.
2. Run tests to confirm missing/incorrect config.
3. Add `render.yaml`: free Render web service with `Dockerfile`; set name/region vars; note Postgres/Redis are `variable:`-driven external services to be created/connected by user; health is `/api/health`; `startCommand` runs migration + API+worker in one service.
4. Update `Dockerfile`: Node 22, healthchecks that tolerate Render, production command is a shell launcher; no wildcard port binding; build is lean.
5. Run `npm run build`, `npm run typecheck`, `npm run lint`; fix any deployment/compile blockers found.
6. Write `DEPLOY.md` account-setup section: how to connect Render repo, create/connect Neon Postgres and Upstash Redis, fill Render secret env vars (never pasted here), URL mapping (`APP_URL`, `SOCKET_ORIGINS`/CORS), email provider setup, and post-deploy smoke steps.

---

### Task 4: End-to-end smoke, errors, validation, CORS/throttling, and queues

**Files:**
- Test: `test/integration/deploy-smoke.test.ts`
- Test: `test/unit/cors-errors.test.ts`
- Modify: `src/modules/identity/guards/jwt-auth.guard.ts`
- Modify: `src/main.ts`
- Modify: `src/shared/validation/sanitize.ts`
- Modify: `src/shared/filters/all-exceptions.filter.ts`

**Steps:**
1. Write tests: public SPA error route returns clean 404; `/api/nope` returns clean 404; SPA 404 route works; guards return 401/403 with `requestId`; CORS rejects disallowed browser origins (fail-closed); throttled auth endpoint returns 429 with Retry-After.
2. Run to see current failures.
3. Fix: ensure public `GET /nope` returns clean 404 (does not leak API error behavior); add proper `GET` SPA fallback only after unknown-path clean render or blank visual fallback as appropriate; add safe request-ID logging; make CORS origin-denied behavior explicit and secure (e.g., 401/403 JSON or no wildcard); fix guard/error code consistency.
4. Run typecheck, lint, and integration suites (auth/security/error/CORS if present). Report precise statuses.

---

### Task 5: Permissions, alerts, persistence, and end-to-end functions

**Files:**
- Test: `test/integration/admin-invite-and-errors.test.ts`
- Modify: `src/modules/students/students.service.ts`
- Modify: `src/modules/students/student-import.ts`
- Modify: `src/modules/reports/reports.controller.ts`
- Modify: `src/modules/reports/reports.service.ts`
- Modify: `src/shared/db/schema.ts`
- Create: `drizzle/0010_report_artifacts.sql` (if required after builder checks)

**Steps:**
1. Write tests: import-only route returns clean 400/403 in demo mode; invite path remains inside `@ui.ac.id` and enforces duplicates; report download has clean fallback when queued/processing; no public register.
2. Run to see current status/failures.
3. Implement closure decisions for import/provisioning that do not break build; make invite accept start/end dates and enforce staff-only creation. Add index/documentation for new export columns if artifacts persist.
4. Use DB `bytea` + text key for report artifacts (or add durable storage if approved); write regeneration/fallback; list through admin-only.
5. Run typecheck, lint, and relevant integration suites; fix regressions.

---

### Task 6: Deployment readiness, DB/upstash checks, and user smoke verification

**Files:**
- Modify: `DEPLOY.md`
- Modify: `docker-compose.yml` (as needed, with clear env mapping)
- Modify: `src/shared/config/configuration.ts` (pool/TLS config if needed)
- Test: `test/integration/deploy-smoke.test.ts` (update)

**Steps:**
1. Write config/smoke checks: prod refuses weak JWT_SECRET; upstash accepted via `REDIS_URL` including `rediss://`/TLS handling; pool sizes sane (`DB_POOL_MAX`, `REDIS_BLOCK_TIMEOUT`, etc.); DB initial migrate works with pgvector against Neon.
2. Run and document configuration issues; fix code so health/stack works with Neon/Upstash.
3. Update `DEPLOY.md` Render sections: pre-deploy, health, quota expectations, expected messages, escalation notes.
4. Ensure `docker-compose.yml` still uses defaults and remains the documented local path; add optional compose overrides where needed.

---

### Task 7: Security and access audit using the requested skills

**Files:**
- Create: `docs/superpowers/audits/2026-11-21-free-render-demo.md`
- Modify: as fixes from review are made; use `git status`/diff as evidence.

**Steps:**
1. Install/use the requested security-audit skill (`npx skills add https://github.com/cloudflare/security-audit-skill --skill security-audit`) if tooling/network is available; document inability to install/run here if not. Run a focused `security audit this codebase` as possible, scoped to this public demo plus changed diffs. Report limitation honestly.
2. Run/use Ponytail audit (`ponytail /ponytail-audit` or equivalent) as applicable; record findings and decisions. If unavailable in this harness, document and simulate as reusable audit checklist.
3. Add/verify tests for each confirmed finding or hardening gap: old/audit findings that are relevant to public access (e.g., XSS fallback handling, CORS, bot, auth, secrets, errors, quotas).
4. Re-run strict lint/typecheck/unit/integration to confirm no regressions.
5. Write a short audit report with sources: repo lines, tests/commands that fail/pass, exact limitation statements, and final status. It should explicitly not claim OWASP certification or full production security.

---

### Task 8: Live-link boundary verification and demo handoff

**Files:**
- Modify: `DEPLOY.md`
- Test: `test/integration/deploy-smoke.test.ts`

**Steps:**
1. User creates Render web service, creates/links Neon Postgres and Upstash Redis, fills secret env (JWT_SECRET, DATABASE_URL, REDIS_URL, APP_URL, CORS/SOCKET origins if needed), deploys from this branch, shares the public URL, and creates an admin/test identity. User owns secrets/accounts/URL.
2. If the live URL is available, verify: public SPA load, error fallback on bad routes, unauthenticated staff pages return 401/403, register/login outcomes match tests, admin-invited student flow can be attempted; document exact outputs. Do not claim security if not performed.
3. If live URL not available, document the handoff checklist and caveats clearly.
4. Add/update `DEPLOY.md` final "Deployable demo checklist": secrets, first migration, first admin via safe shell/admin endpoint, smoke URL list, sleep behavior, quota warnings, cancel/backout.

---

Self-Review:

- Spec coverage:
  - Confirmed no public student registration. (`Task 1`)
  - Shared API+BullMQ worker for free Render. (`Task 2`)
  - Public, free, documented deploy path. (`Task 3`)
  - Error/validation/CORS/rate-limit/auth controls verified. (`Task 4`)
  - Admin/import/export/role paths preserved or closure documented. (`Task 5`)
  - Neon/Upstash compat, DB pool, and timeout checks. (`Task 6`)
  - Security audit with requested Cloudflare skill and Ponytail skill attempted/reported honestly. (`Task 7`)
  - Live boundary documented after URL, without claiming an unattested public site is ready. (`Task 8`)
- Step scan: No boilerplate TBD/skip. Verification commands are explicit. Every fix names the controlling test that fails first.
- Type consistency: Repeatedly check naming/path consistency across tasks (e.g., `Supervisor` vs `WorkerLifecycle`, `/auth/register`, `APP_URL`, `SOCKET_ORIGINS`, pool/timeout names).
- Review Focus: Covered auth/input bypass, CORS, crawler, secrets, sleep/lifecycle, public fallback, admin flow, and auditability.
- Proportion: Plan length is larger than spec but maps to the broad user request; no subsystem should be carved unless real verification shows overlap.
