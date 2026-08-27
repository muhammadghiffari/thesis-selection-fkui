# AGENTS.md — Thesis Selection Platform (FKUI)

## Project Context
A thesis title selection platform for 300+ concurrent medical students at FKUI.
Students "war" (first-come-first-served) simultaneously when selection opens.
Modular monolith, reusable across academic years via selection periods.
Thesis titles are SECRET until opens_at. Every student MUST claim EXACTLY 3 titles,
ordered by priority (1, 2, 3) — no fewer, no more.

## Stack (MANDATORY — do not substitute)
- Backend: Node.js 22 LTS, NestJS (TypeScript strict mode), modular monolith
- DB: PostgreSQL 16 + pgvector, ORM: Drizzle
- Cache/Lock/PubSub: Redis 7, Queue: BullMQ
- Realtime: Socket.IO (self-hosted, same process)
- Frontend: React 19 + Vite + Tailwind CSS 4 + shadcn/ui + TanStack Query/Table
  + Zustand + Framer Motion; mobile-first; PWA in later phase
- Auth: magic link (signed JWT, single-use, bound to first device fingerprint) for
  students; email + password (Argon2id) + optional TOTP 2FA for admin/lecturer
- Email: Resend behind a provider interface abstraction
- Testing: Vitest + Testcontainers (integration), Playwright (e2e), k6/Artillery (load)
- Deploy: Docker Compose (app, postgres 16 + pgvector, redis 7)

## Roles & Access Rules
- `admin`: full access (periods, master data, live monitor, integrity queue, audit log).
  Email domain unrestricted.
- `lecturer`: supervisor dashboard only (own theses, swap review, revoke with reason,
  integrity alerts). Email domain unrestricted.
- `student`: MUST have email ending in `@ui.ac.id` (configurable via env
  STUDENT_DOMAINS). Validated in service layer AND DB constraint. Accesses system
  exclusively via scheduled magic link bound to a period and time slot.

## CRITICAL Business Rules (NEVER violate)
1. RACE CONDITION: a claim = Redis `SET NX EX 30s`, then INSERT guarded by partial
   unique indexes. Winner = first request to ARRIVE AT THE SERVER. Losers get an
   instant response (<300ms p95 at 300 concurrent users).
2. TITLE SECRECY: thesis titles are NEVER exposed through any student-facing API
   before `opens_at`. Server-authoritative reveal only.
3. EXACTLY 3 TITLES: each student may hold at most 3 active selections
   (priority 1–3, one per priority slot via partial unique index). Reject the 4th
   claim. At closes_at, students below 3/3 are marked incomplete and notified.
4. TIMING: lock TTL = 30s (Redis auto-expire, NO cron jobs). Undo window = 15s after
   final claim. Grace period after approved swap = 60s. All times server-authoritative;
   store UTC, render WIB on client.
5. SWAP REQUESTS: category + free-text detail (min 20 chars) mandatory; cancelable
   until decided; cooldown 5 minutes between requests; max 1 active per student.
   Approve → pending_release grace 60s → available or re-warred. Old owner gets
   attempts_left++. Every review decision requires a written reason.
6. INTEGRITY (human-in-the-loop): rule-based scoring per selection:
   track mismatch +25, duplicate device fingerprint +25, IP sharing (>2 users/IP) +20,
   lock-to-confirm <2s +15, pre-opens_at access attempt +15, magic link opened from
   different device +20.
   Thresholds: >=70 HIGH (notify admin+lecturer, mandatory manual review),
   40–69 MEDIUM (review queue), <40 CLEAN (hidden). Track mismatch is a SOFT FLAG
   ONLY — never blocked by the system; decision belongs to lecturer/admin.
   NO auto-revoke ever. All decisions require reason + immutable audit log.
7. WATCHERS: students subscribe to titles in swap_requested/pending_release states
   (max 10 per student). One notification per transition to available
   (in-app realtime + email fallback if tab closed).
8. AUDIT LOG: append-only, partitioned monthly, soft deletes on all primary entities.
9. MODULE BOUNDARIES: modules must NOT import each other directly; communicate via
   interfaces and the event bus.

## Module Structure
src/modules/: identity, students, theses, periods, selection, swap, watchers,
integrity, realtime, notifications, audit, reporting, support, ai
src/shared/: db, redis, event-bus, guards, dto
workers/: BullMQ processors (email, embedding, export, expiry-events)
web/: React frontend

## Title State Machine
available -> locked(30s) -> taken -> (undo <=15s) -> available
locked --timeout--> available
taken --swap_request--> swap_requested --cancel--> taken
swap_requested --approve--> pending_release(60s) --> available | taken
taken --revoke(lecturer/admin, reason required)--> available (+attempts_left++ for old owner)

## UI Status Vocabulary (student-facing cards)
available=green [CLAIM NOW] · locked=gray timer [LOCKED] · taken=faded [TAKEN]
swap_requested=yellow "may become available!" [WATCH] · pending_release=blue pulsing
grace countdown [CLAIM NOW!]

## Definition of Done (per feature)
- Integration test: 100 virtual users claiming the same title → exactly 1 winner
- Type-check & lint pass (strict mode)
- Audit log entry recorded for every mutation
- UI is mobile-first; card status updates live without refresh

## Delivery Status (update after each merged PR)

- F1 scaffold: DONE (CI green: lint, unit, integration, compose-smoke)
- F2-auth: DONE — JWT access+refresh rotation, requireAuth/requireRole guards,
  roles student/lecturer/admin
- F2 master data: DONE — bulk import/export xlsx/csv w/ validation, period CRUD
  - lifecycle + clone, bulk actions, admin shadcn/ui tables
- F3 magic links: DONE — single-use JWT bound to first device fingerprint,
  BullMQ one-shot delayed stage scheduler w/ exactly-once guard, admin delivery
  dashboard + audited resend. Note: scheduling uses one-shot delayed jobs from
  period.scheduled event, NOT interval repeatables. EmailProvider port w/ stub.
- F4 pre-war lobby: DONE — server-authoritative countdown (/api/lobby serverTime),
  EmbeddingProvider port + student_preferences (pgvector 1536-dim, hashing stub,
  local MiniLM plugs in later), auto-war opt-in w/ persisted consent, rules page,
  dedicated secrecy suite (23 student endpoints asserted pre-opens_at).
- F5 war engine: DONE — Redis SET NX EX 30s + dual partial unique indexes,
  race suite 100 users = 1 winner/0 double-claims/0 orphans, server p95 ~370ms
  (re-validate in F11), undo window, exactly-3 enforcement, transactional
  reorder, idempotency keys, THS-{year}-{seq} receipts, auto-war heartbeat-gated
  WarRunner. CRITICAL FIX: unplugin-swc decoratorMetadata added to vitest —
  DTO validation now actually runs in tests.
- F6 realtime: DONE — EventBus -> Redis pub/sub -> Socket.IO fan-out per instance,
  rooms lobby:{periodId}/admin/lecturer:{id}/thesis:{id}, JWT handshake guard,
  reconnect = REST snapshot reconciliation (churn test 0 mismatches), admin
  broadcast banner (audited), measured latency 27-36ms.
- F7 swap engine: DONE — full state machine w/ transition matrix green, grace
  expiry via delayed BullMQ job, reclaim-during-grace, watchers (cap 10,
  exactly-once notify via atomic notified_at=transition-ts), mandatory decision
  notes, revoke w/ reason, idempotency keys on swaps. Realtime via existing bus
  mappings only.
- F8 supervisor integrity: DONE — rule-based scoring (6 signals, weights,
  HIGH>=70/MEDIUM40-69/CLEAN<40) async BullMQ idempotent, lecturer dashboard
  scoped to own theses w/ swap review + revoke + alerts (note mandatory),
  admin live monitor + integrity queue, audit viewer. NO auto-revoke.
- F9 reporting + archive: DONE — async export jobs (xlsx ExcelJS, PDF Puppeteer
  w/ graceful pdf-browser-unavailable), exactly-once ready-notification,
  archive preconditions + assertPeriodMutable freeze guard, clone carries
  catalog+settings (never enrollments/selections), audit indexed pagination +
  filtered CSV. Puppeteer image impact ~+1.5MB.
- F10 support chat: DONE — RAG over rules-content.ts (support_chunks pgvector 1536-dim,
  ivfflat index, idempotent upsert at startup), StubLlmProvider (dev/test) + Groq
  (prod via GROQ_API_KEY) with 8s timeout + graceful stub fallback, title-secrecy
  sanitization defense-in-depth, quick self-service actions (check-status no-title-leak,
  resend-magic-link via MAGIC_RESEND_PORT, swap-guide static), escalation tickets
  (auto-context, WhatsApp deep-link wa.me), admin queue list/resolve (mandatory note +
  audit log), rate limits (20/min chat, 1/5min resend). Integration tests green.
- NEXT: F11 load test 300 concurrent + hardening + PWA

## Implementation Notes (gotchas discovered)
- Nest DI requires explicit @Inject(...) tokens (no emitDecoratorMetadata) —
  see authService/guards for the pattern.
- Worker container is NOT an HTTP server — its healthcheck is a pgrep process
  check, not curl. Never reintroduce an HTTP healthcheck for worker.
- Baseline test suite: all green on main. Do not regress.
