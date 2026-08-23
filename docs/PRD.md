# PRD — Thesis Title Selection Platform (FKUI)
Product Requirements Document · v1.1 FINAL

## 1. Background
FKUI needs a fair, fast, transparent system for selecting thesis research titles.
The previous manual process suffered from race conditions when hundreds of students
accessed simultaneously, forgeable identities, no audit trail, and single-use design.

The new system is a modular monolith reusable across academic years, with an
atomicity-guaranteed first-come-first-served engine and a human-in-the-loop
integrity layer.

## 2. Goals & Success Metrics
| Goal | Metric |
|---|---|
| Simultaneous war without anomalies | 0 double-claims; p95 lock response <300ms @ 300 concurrent |
| Fairness | Winner determined purely by server arrival order; zero pre-opens_at access |
| Minimal admin burden | >=80% questions resolved self-service/AI; swaps resolved <1 working hour |
| Reusable | Next-year period creatable via clone in <30 min |
| Minimal cost | Operations <= IDR 60k/month at <=500 students |

## 3. Personas
| Persona | Description | Key Needs |
|---|---|---|
| Student (~300+/period) | Must use @ui.ac.id email; class (Regular/KKI) and research track (Clinical/Basic/Community) pre-provisioned by admin | Fast war, clear status, quick help on failure |
| Lecturer (supervisor) | Owns research titles | Real-time monitoring of claims, swap review, revoke on misconduct |
| Admin | System operator (incl. owner) | Bulk management, live war monitor, integrity decisions |

Terminology note: "war" is internal jargon for the selection opening moment.
Official student-facing communication uses "title selection".

## 4. Design Principles
1. Server-authoritative — time, state, decisions come from the server; clients render.
2. Atomicity by design — Redis SET NX EX + PostgreSQL partial unique indexes as two layers.
3. Invisible security — all controls passive; student experience stays <=2 taps to lock.
4. Human-in-the-loop — scores flag, humans decide. AI confidence <85% => mandatory admin review queue.
5. Title secrecy — catalog hidden until opens_at; never exposed via student APIs.

## 5. Feature Scope

### 5.1 Academic Period Management (multi-year reuse)
- CRUD periods: name, academic year, opens_at/closes_at, settings (lock 30s,
  undo 15s, grace 60s, required_selections=3, attempts_default=4, watch max 10,
  mode first_come).
- Lifecycle: draft -> scheduled -> open -> closed -> archived.
- Clone period: copy structure for next year; historical data archived but exportable.

### 5.2 Student Master Data
- Bulk import XLSX/CSV (drag-drop, preview, inline validation: numeric NPM,
  @ui.ac.id email, duplicate detection).
- Pre-provisioned fields: full name, NPM, class_type (regular/kki),
  research_track (clinical/basic/community), email. Students NEVER enter identity.
- Bulk multi-select actions: assign slots, send magic links, reset attempts, deactivate.
- Export filtered results to XLSX.

### 5.3 Thesis Master Data
- CRUD + bulk import/export per period; attributes: title, supervising lecturer,
  track, description, max_claims.
- Embeddings generated at upload (for AI matching); titles remain hidden from
  student endpoints until opens_at.

### 5.4 Authentication & Scheduled Access
- Magic link: single-use signed JWT containing identity + period + time slot
  (access_from/access_until), bound to first device fingerprint.
- Auto-blast H-7; reminders H-1, H-1 hour, T-10 min (in-app), H-2 hours before
  closes_at warning for incomplete (<3/3) students.
- Delivery tracking per student (sent/opened/claimed); individual resend.
- Admin/lecturer: email+password Argon2id + optional TOTP.

### 5.5 Pre-War Lobby (H-7 to opens_at)
- Countdown to opens_at (server timestamp).
- AI preference capture: student describes research interests -> stored as embedding.
- Auto-war setting (opt-in): at opens_at, system recommends/locks best-matching title
  — REQUIRES open tab (fairness), explicit pre-confirm consent.
- Rules guide.

### 5.6 War Room (Selection Engine) — CORE
- Grid revealed simultaneously at opens_at.
- Instant lock WITHOUT modal: tap card = immediate Redis lock (30s TTL);
  banner timer on card; buttons [Claim Final] / [Release].
- One active lock per student (new lock releases old one).
- Claim final = instant win; undo window 15 seconds post-claim.
- Race handling: winner = first request arriving at server; losers get instant
  response + one-click fallback recommendation matched to their preference embedding.
- Idempotency key per attempt; rate limiting per session.
- Progress tracker sticky: "Titles claimed: X/3".
- Live grid: every state transition broadcast real-time.

### 5.7 Title State Machine
available --lock--> locked(30s) --confirm--> taken --undo<=15s--> available
locked --timeout--> available
taken --swap_request--> swap_requested --cancel--> taken
swap_requested --approve--> pending_release(60s) --> available | taken
taken --revoke(reason required)--> available (+attempts_left++ old owner)

Card visuals: green available / gray locked+timer / faded taken /
yellow swap_requested ("may become available!") / blue pulsing pending_release countdown.

### 5.8 Watchers (Notify Me)
- Subscribe to titles in swap_requested/pending_release (max 10).
- In-app realtime toast + email fallback when status becomes available;
  once per transition (notified_at guard).

### 5.9 Swap Requests
- Mandatory: reason category (wrong pick / interest mismatch / lecturer-schedule
  issue / other) + free-text detail min 20 chars.
- Consequence preview before submit; cancelable until decided; 5-min cooldown;
  max 1 active per student.
- Review by lecturer/admin with mandatory decision note; immutable audit log.
- Approve -> 60s grace; old owner may re-war during grace; attempts_left++.

### 5.10 Integrity & Anti-Cheating (human-in-the-loop)
Rule-based score per selection:
track mismatch +25, duplicate device fingerprint +25, IP sharing (>2/IP) +20,
lock-to-confirm <2s +15, pre-opens_at access attempt +15, link opened from
different device +20.
Thresholds: >=70 HIGH (notify admin+lecturer, mandatory review), 40-69 MEDIUM
(queue), <40 CLEAN (hidden). Track mismatch = SOFT FLAG only, never system-blocked.
Admin outcomes: false_positive / investigate / revoke (reason mandatory).
AI confidence <85% => always human review. Never auto-revoke.

### 5.11 Lecturer Supervisor Portal
- Overview stats for own titles; My Theses real-time table (owner, claim time,
  integrity score).
- Swap request queue for own titles (approve/reject + note).
- Integrity alerts on own titles + Revoke action (release + broadcast + notify
  student with reason).

### 5.12 Admin Dashboard
- Per-period real-time stats & charts; Live Monitor (activity feed, claim rate,
  force-release lock, emergency close, global broadcast banner).
- Selections management: bulk approve/reject, reset, audit log viewer (immutable,
  monthly partitions).
- Async reporting (XLSX/PDF via worker) + ready notification.

### 5.13 Notifications
Event->channel matrix (email/in-app/optional webhook), notification_deliveries
table with retry queue. Success receipt (page + email to @ui.ac.id) contains:
ordered list of 3 claimed titles + lecturers, NPM/name/class, claim timestamps,
reference numbers THS-{year}-{seq} per selection, QR verification, undo/swap info,
status-check link. Failure cases: specific message per cause + action buttons
(fallback recommendation, chat admin, WhatsApp deep-link) — no panic emails.

### 5.14 Support Chat
Quick self-service actions FIRST (check schedule, resend magic link, swap guide,
FAQ RAG) -> escalation ticket to admin / WhatsApp deep-link only if quick actions
fail. Tickets carry automatic context (name, period, last error).

## 6. Non-Functional Requirements
| Aspect | Target |
|---|---|
| Performance | p95 lock <300ms @ 300 concurrent; broadcast <500ms to all clients |
| Availability | 99.5% during war window; graceful degradation (queued side-effects) |
| Scalability | Stateless app replicas; Redis pub/sub; BullMQ workers |
| Security | Argon2id, signed JWT, device binding, rate limiting, encryption at rest for sensitive data, strict RBAC |
| Observability | Structured logs (Pino), error tracking (Sentry optional), health checks |
| Testing | Concurrent integration tests; e2e Playwright; load test 300 virtual users |
| Cost | Free-tier first; est. IDR 0-60k/month |

## 7. Architecture Summary
- Runtime: Node.js 22 + NestJS modular monolith (modules: identity, students,
  theses, periods, selection, swap, watchers, integrity, realtime, notifications,
  audit, reporting, support, ai).
- Data: PostgreSQL 16 (+pgvector), Drizzle ORM.
- Infra: Redis 7, BullMQ, Socket.IO, Docker Compose.
- Frontend: React 19 + Vite, Tailwind 4 + shadcn/ui, TanStack Query/Table, Zustand,
  Framer Motion; mobile-first; PWA later.
- External: Resend/SES, Groq/Llama local chatbot, local embeddings (all-MiniLM) or cheap API.

## 8. Build Roadmap
F1 Foundation (scaffold, Docker, migrations, RBAC, CI)
F2 Admin master data (bulk import/export, periods + clone)
F3 Magic link scheduler + blasts + tracking
F4 Lobby (countdown, AI preference capture, auto-war settings)
F5 War engine (instant lock, confirm, undo, exactly-3 enforcement, receipts) CORE
F6 Real-time layer (event bus, rooms, reconnect reconciliation)
F7 Swap engine (request/review/cancel/grace/watcher notify)
F8 Lecturer supervisor suite + integrity scoring + review queues
F9 Reporting async + archive/clone + audit viewer
F10 Support chatbot (quick actions -> escalation) + anomaly upgrade
F11 Load test 300 concurrent + hardening + PWA

## 9. Out of Scope (v1)
SIAK/Academic UI integration, payments, native mobile apps, multi-language,
lottery mode (kept as future settings option).

## 10. Resolved Decisions
1. Capacity: sized for 300+ concurrent students.
2. Track mismatch: soft-flag only; decision belongs to lecturer/admin.
3. Student email domain: @ui.ac.id enforced, configurable via STUDENT_DOMAINS env.
4. Each student claims EXACTLY 3 titles, ordered priority 1-3, no more no less.
