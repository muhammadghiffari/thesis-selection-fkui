# Security & Access Audit — Free Render Demo Readiness

**Date:** 2026-11-22
**Target:** `thesis-selection-fkui` (working tree under review; dirty, uncommitted work preserved)
**Scope:** the work changes for `2026-11-21-free-render-demo-readiness` (Tasks 1–6) that form the public-demo attack surface, plus the trust boundaries they touch.
**Verdict style:** `confirmed` / `needs_validation` / `rejected`. No severity is assigned to `needs_validation` or `rejected` records (per the security-audit skill's separation of certainty from priority); where useful, a *potential* severity is shown in parentheses but is explicitly not a confirmed finding.

> This is a scoped, source-first review of a **demo**, not a production penetration test. It is **not** an OWASP certification and makes **no** claim that the service is "fully secure".

---

## 1. Scope, methodology, and honest limitations

### Requested skills

1. **Cloudflare `security-audit` skill** — installation was **attempted and succeeded**:
   `timeout 45s npx -y skills add https://github.com/cloudflare/security-audit-skill --skill security-audit` exited `0` and installed to `.agents/skills/security-audit` (skills.sh risk assessment shown: Gen "Safe", Socket 0 alerts, Snyk "Med Risk"). The skill's six-phase full-audit workflow was then read (`SKILL.md`, `RECONNAISSANCE.md`, `HUNTING.md`, `VALIDATION-AND-REPORTING.md`, `ATTACK-CLASSES.md`).
   - **Full-mode limitation:** the skill *requires* an OS-enforced sandbox for all target-controlled execution (no external network; empty allowlisted environment; read-only target/toolchain; scratch-only writes; explicit CPU/memory/process/file/disk/wall-clock limits) and independent delegated hunter/verifier agents. This environment has **no such sandbox**, no reliable isolated agent fleet, and **no Docker**, so full mode could not be run honestly. I therefore **applied its methodology manually at a scoped level**: map trust boundaries/input surfaces → hunt the changed diffs → **try to disprove every candidate** with file:line evidence and existing tests → classify → report without overclaiming.
   - **Cleanup:** the installed skill directory is a CommonJS-validator tooling artifact that the repo's ESLint config rejects (`@typescript-eslint/no-require-imports`: 24 errors across its `.cjs` files). It was removed after its methodology was extracted so `npm run lint` stays green. No product code was changed by the install.

2. **Ponytail** (`DietrichGebert/ponytail`) — **already active** in this repo via the root `AGENTS.md` ("Ponytail, lazy senior dev mode"). No reinstall attempted, per instruction. Its principles were applied throughout Tasks 1–6: reuse existing helpers/patterns, no new dependencies, no unnecessary migrations, verify-don't-rewrite, the smallest working diff, one small runnable test per non-trivial change, and `ponytail:` comments naming deliberate simplifications (e.g. the hardcoded `@ui.ac.id` DB trigger). This audit is itself docs-only for that reason.

### Execution boundary (what was and was not done)

- **Done (source-first):** read the changed diffs and the live files at each trust boundary; traced input → decision → sink; cross-checked each candidate against an existing unit/structural test; ran local, non-Docker checks.
- **Not done (stated plainly):** no dynamic exploitation, no live endpoint probing, no OS-enforced sandbox, no integration test that boots Postgres/Redis (Docker absent), and **no live Render URL** exists yet (Task 8 is a separate handoff). Anything requiring those is `needs_validation`, not `confirmed`.
- **Verification run for this audit (all green, no regressions):** `npm run typecheck` (exit 0), `npm run lint` (exit 0), `npm run test:unit` (64/64), structural config tests `test/integration/deploy-config.test.ts` (10/10). See §7.

---

## 2. Trust boundaries / attack surface map (brief)

| # | Boundary | Lower-trust principal → protected resource | Strongest source-visible control |
|---|---|---|---|
| B1 | Public HTTP → auth | anonymous → staff session | no register route; staff-only login; argon2id + dummy-hash timing; `@Roles('admin')` staff creation |
| B2 | Student token → admin/lecture data | magic-link `student` JWT → staff/admin endpoints | global `JwtAuthGuard` + `RolesGuard`; role minted server-side (`'student'`), role re-read from DB on refresh |
| B3 | Import/enrollment → identity | admin CSV → `users(role=student)` | service-layer domain check + DB trigger; bulk routes `@Roles('admin')` |
| B4 | Browser → API (CORS) | arbitrary web origin → authenticated JSON | allowlist-only CORS callback, fail-closed, `credentials:false`, no origin echo |
| B5 | Untrusted input → parsers/render | request body/query/params → DTO/DB/log | sanitize interceptor → whitelist ValidationPipe → Drizzle parameterized queries → CSP + React text rendering |
| B6 | Anonymous → reset flow | email owner → staff password change | generic 200, hashed single-use 30-min token, atomic consume, session revocation, per-email/IP budgets |
| B7 | Deployment config → runtime | operator env/secrets → production boot | JWT_SECRET strength guard, no secrets in `render.yaml`, non-root container, TLS URLs |
| B8 | Free-tier shared process → lifecycle | worker exit → API availability | supervisor closes siblings; shutdown hook in `main.ts` (partial — see NV-03) |
| B9 | Crawler → public surface | AI/scraper UA → SPA/API | UA denylist + `robots.txt`/`security.txt` (deterrent only, not access control) |
| B10 | Logs/alerts → operators | request headers/body → log sink | pino redaction, bounded requestId, generic 500, webhook throttling |

---

## 3. Findings

### 3.1 Rejected candidates (claim disproved by source + tests)

| ID | Candidate claim | Status | file:line | Disproof evidence |
|---|---|---|---|---|
| R-01 | CORS reflects origins / wildcard / throws 500 | **rejected** | `src/shared/security/cors.ts:16-37` | Exact allowlist match only; rejected origin → `callback(null,false)` (no error, no echo, no wildcard); `credentials:false`. `test/unit/cors-errors.test.ts:22-133` asserts near-misses fail closed and no error reaches `next()`. |
| R-02 | requestId header enables log injection / oversized IDs | **rejected** | `src/main.ts:55-64`, `src/shared/logging/logger.module.ts:11-29` | Incoming ID must match `^[A-Za-z0-9._:-]{1,64}$` else UUID; pino-http uses `req.id = req.id \|\| genReqId(req)` (`node_modules/pino-http/logger.js:141`) so the pre-set sanitized value wins; redaction covers `x-request-id`. CRLF would be JSON-escaped by pino regardless. |
| R-03 | Public student self-registration still reachable | **rejected** | `src/modules/identity/auth.controller.ts:24-79` | No `register`/`signup` route anywhere in the identity module (grep confirms only a conflict-message string). Routes: login/refresh/logout/forgot/reset/staff(`@Roles('admin')`)/me. `test/integration/admin-invite-and-errors.test.ts:116-121` asserts `POST /auth/register → 404`. |
| R-04 | Student token can reach admin actions | **rejected** | `src/modules/identity/guards/roles.guard.ts:17-32`, `identity.module.ts:41-42`, `notifications.service.ts:250`, `refresh-tokens.service.ts:68-76` | 17 `@Roles(...)` decorators across controllers; magic-link sessions mint `role:'student'`; refresh re-reads role from DB (no token-self-escalation); `staff` creation anon→401 / student→403 / admin→201 asserted at `admin-invite-and-errors.test.ts:84-103`. |
| R-05 | Non-`@ui.ac.id` student can be provisioned | **rejected** | `student-import.ts:45-66`, `drizzle/0000_init.sql:41-56` | Service checks `endsWith('@'+domain)` from `STUDENT_DOMAINS`; DB `BEFORE INSERT OR UPDATE OF email,role` trigger raises `23514` for any `student` row not ending `@ui.ac.id`. (Known config mismatch → NV/hardening H-01.) |
| R-06 | Stack traces / internals leak in 500s; error pages leak API behavior | **rejected** | `src/shared/filters/all-exceptions.filter.ts:52-118`, `web/src/pages/ErrorPages.tsx`, `main.ts:99-105` | Non-HttpException → fixed `{code:'INTERNAL_ERROR',message:'Internal server error'}`; no stack/SQL/path in body. `test/unit/cors-errors.test.ts:197-205` asserts a seeded secret/secret path is absent. SPA fallback only for `GET` + `text/html`, never `/api/*`. |
| R-07 | Stored XSS / SQL injection via request input | **rejected (as an exploitable path in changed code)** | `sanitize.ts:16-64`, `main.ts:82-91`, all DB access via Drizzle | Sanitizer strips control chars/HTML tags, caps length/array; whitelist ValidationPipe rejects unknown fields; all queries parameterized; CSP `script-src 'self'`, no `unsafe-eval`; frontend renders text. `test/unit/security-hardening.test.ts:7-23`. Sanitizer is defense-in-depth, not the primary control (hardening H-02). |
| R-08 | Hardcoded secrets / weak JWT secret in demo config | **rejected** | `src/shared/config/configuration.ts:29-56`, `render.yaml:16-41`, `Dockerfile:21-35` | `requireEnv('JWT_SECRET')`; production refuses default/<32-char secrets; `render.yaml` uses `sync:false`/`generateValue:true` for every secret — no hardcoded values; auth material comes from env only. `test/integration/deploy-config.test.ts:48-55`. |
| R-09 | Worker processor can silently use a stub email provider in demo | **rejected (source)** | `render.yaml:47-48` (`MAIL_PROVIDER=resend`), `configuration.ts:72-73`, `src/shared/notifications/email-provider.ts` | Production config selects `resend` when configured; stub is dev/test default only. Real delivery still requires user-owned verified sender (documented limitation, not a code defect). |
| R-10 | SSRF via user-controlled URL in changed code | **rejected (not applicable)** | `email-provider.ts`, `groq-llm-provider.ts:47`, `alerts.service.ts:30-40` | Outbound URLs are fixed provider endpoints from trusted env/config, never attacker-supplied request input; nowebhook/callback URL field is accepted from users. |

### 3.2 Needs validation (source-grounded hypothesis; decisive fact outside local observation)

| ID | Potential sev. | Candidate | file:line | Exact blocker | Safe resolution plan |
|---|---|---|---|---|---|
| **NV-01** | *Low (if validated)* | Password-reset enumeration via delivery failure: `requestReset` returns generic 200 for unknown/student emails, but **rethrows** when `email.send()` fails — an existing staff email then yields 500 while a non-existent one yields 200. On a free demo with a user-supplied/unverified sender, provider failure is a realistic condition. | `password-reset.service.ts:50-108` (esp. `92-102`) | Cannot exercise a real/failing provider locally (no DB/Redis/Docker, no live URL); whether the failure is observable depends on deployed mail config. | **Local:** unit test with a mocked `EmailProvider` whose `send` rejects; assert `requestReset` still resolves `{sent:true}` (it currently throws). **Smallest fix:** log-and-swallow send errors and always return the generic 200; keep the audit entry. |
| **NV-02** | *Medium (if validated)* | IP-keyed throttling / login-failure budgets may be bypassable via `X-Forwarded-For` spoofing: `trust proxy = 1` + `req.ip` keys for `ThrottlerGuard` and `LoginRateLimiter`. If the platform LB *appends* rather than overwrites XFF, a client-supplied leftmost value becomes `req.ip`; rotating it opens fresh rate buckets for brute-force. | `configuration.ts:76`, `main.ts:26`, `throttler.guard.ts:33-47`, `login-rate-limiter.ts:13-31` | Proxy/XFF handling is an unobserved deployment fact; no OS-enforced loopback proxy harness or live URL to confirm. Do **not** claim either presence or absence. | **Owner-observed:** on the deployed demo, send a request with a forged `X-Forwarded-For` and confirm whether the LB overwrites it (check what the app logs as `req.ip`/`X-Forwarded-For`). **Local:** bounded isolated-loopback proxy fixture. **Defense-in-depth already present:** per-email failure budget shares the key, magic-link (not password) student auth, 60/min auth throttle; consider keying sensitive limits on a stable user/email component. |
| **NV-03** | *Low (reliability, if validated)* | Sibling worker exit does not shut the API down: `bootWorkersInProcess` closes other workers and fires `onSiblingExit` callbacks, but `main.ts` never registers a callback that calls `stop()`. A dead worker could leave a healthy-looking `/api/health` with no workers (scheduled magic links / grace expiry stall). | `worker-lifecycle.ts:44-72`, `main.ts:109-126` | Requires a real worker-exit event in the shared process to confirm operational impact; unit tests prove notification but not that the API exits. | **Local:** assert `main.ts` wires `runtime.onSiblingExit(() => stop())` (a one-line hardening fix). **Owner-observed:** on the live demo, kill one worker and confirm the service exits non-zero / restarts rather than serving with zero workers. |
| **NV-04** | *Informational* | No dependency CVE/outdated-package audit was run; Docker build sets `NPM_CONFIG_AUDIT=false`. Lockfile pins versions, but known-vulnerable transitive deps were not checked. | `Dockerfile:4`, `package-lock.json` | No network/CVE database use was in scope for this sandbox-less run; do not assume clean. | Owner runs `npm audit --omit=dev` in CI before launch; treat results as a release gate. |

### 3.3 Hardening notes / positive patterns (not findings)

- **H-01 — `ponytail:` simplification with a known ceiling:** the DB trigger hardcodes `@ui.ac.id` while the service honors configurable `STUDENT_DOMAINS`. With the demo default (`ui.ac.id`) they agree; a non-default domain would be accepted by import then rejected by the DB — **fail-closed**, not a bypass. Named in `drizzle/0000_init.sql:38-40`; upgrade path already documented (move allowlist to a settings table).
- **H-02 — sanitizer scope:** string stripping is defense-in-depth; correctness rests on parameterized queries, whitelist DTOs, React text rendering and CSP. `sanitizeValue` mutates `req.query`, and in Express 5 `req.query` is a getter that may return a fresh object — so query sanitization may not persist. No exploitable sink found in changed code, but do not rely on it as an input guarantee.
- **H-03 — botGuard is a deterrent, not access control:** UA regex is trivially spoofable and exempts `/api/health`; it is correctly paired with real auth on every data route and `robots.txt`/`security.txt`. Never treat a 403 from botGuard as an authorization decision.
- **H-04 — password-reset token in URL query** (`password-reset.service.ts:90-96`): standard for email links; same-origin SPA + CSP (`connect-src/self`, no third-party assets) keeps Referer leakage low. Keep the reset page free of external resources.
- **Positive patterns:** generic 500 + requestId envelope; pino redaction of auth/cookie/body secrets; append-only audit + mandatory notes; hashed single-use tokens; atomic consume-then-verify; idempotent `IF NOT EXISTS` hardening indexes (`drizzle/0008_hardening_indexes.sql`); non-root container; documented backup/rollback (`DEPLOY.md §5`); graceful webhook/email fallbacks that never throw into request paths.

---

## 4. OWASP Top 10 (2021) + ASVS coverage checklist

Legend: **Verified** = source + local test evidence in this run · **N/A** = no applicable surface in scope · **Live check** = requires deployed URL/credentials (Task 8).

| OWASP 2021 / ASVS area | User control | Status | Evidence / note |
|---|---|---|---|
| A01 Broken Access Control (ASVS V4) | Authorization; register closure; `@ui.ac.id` | **Verified** (source + tests; live check pending) | R-03/R-04/R-05; `admin-invite-and-errors.test.ts`; 17 `@Roles` guards. Live: confirm anon/student/admin matrix on the URL. |
| A02 Cryptographic Failures (V7/V9) | Secrets/config | **Verified** | R-08; argon2id `m=19456,t=2,p=1`; hashed tokens; `rediss://` capable config. Live: confirm TLS URLs in Render. |
| A03 Injection (V5) | Input validation / sanitization | **Verified** (defense-in-depth; H-02) | R-07; `sanitize.ts`, `main.ts:83-91`, Drizzle parameterization, CSP. |
| A04 Insecure Design (V2/V4) | Title secrecy; exactly-3; human-in-loop | **Verified** (pre-existing; out of changed diff) | F4 secrecy suite (23 endpoints) + business rules in root `AGENTS.md`; re-confirm in live smoke. |
| A05 Security Misconfiguration (V14) | Error pages; error handling; CORS | **Verified** | R-01/R-06; helmet CSP/HSTS, fail-closed CORS, generic 500, non-root Docker, no secrets in blueprint. |
| A06 Vulnerable Components (V14) | Dependencies | **Live check / needs validation** | NV-04; lockfile pinned, no CVE scan in this run. |
| A07 Auth Failures (V2/V3) | Password reset; rate limiting | **Verified with leads** | Generic 200 + hashed single-use token verified; NV-01 (provider-failure enumeration), NV-02 (XFF/IP keys) remain. |
| A08 Integrity Failures (V8/V10/V15) | Audit; idempotency; signed JWT | **Verified** | Append-only audit, mandatory decision notes, idempotency keys, server-signed HS256 access tokens (secret-string key; `alg:none`/RS256 confusion not accepted by jsonwebtoken with a string secret). |
| A09 Logging & Monitoring Failures (V8) | Logging; alerts | **Verified** | R-02; redaction paths, bounded requestId, webhook throttling + never-throws; generic 500 carries requestId. |
| A10 SSRF (V12) | Outbound URLs | **N/A** in changed surface | R-10; provider endpoints are env/config constants, no user-supplied fetch targets. |
| Availability overlay (V12) | DB indexes | **Verified** | `drizzle/0008_hardening_indexes.sql` — 30+ idempotent partial indexes on hot query paths. |
| Operations overlay | Rollback | **Verified (documented) / live check** | `DEPLOY.md §5` — pre-deploy backup + code-then-data rollback, 30-day retention. Execution requires user-owned Neon Console access. |
| Automated-threat overlay | Anti-crawler | **Verified as deterrent; not access control** | `bot-guard.ts`, `web/public/robots.txt`, `security.txt`; H-03. Live check: SPA bot handling on the URL. |

**Explicitly not claimed:** OWASP certification, "fully secure", production/clinical-data readiness, or a passed penetration test. Free-tier caveats (sleep, delayed jobs, Neon/Upstash quotas, unverified sender) remain per the spec.

---

## 5. Requested-skills usage summary

- **Cloudflare security-audit:** installed successfully; full six-phase mode **not runnable** (no OS-enforced sandbox / no Docker / no isolated verifier fleet / no live target). Methodology applied manually and scoped: boundary map, diff hunting, disproof-first validation, structured statuses, target-neutral report. Install artifact removed to keep lint green.
- **Ponytail:** already active via root `AGENTS.md`; not reinstalled. Its ladder shaped the underlying work (reuse, no new deps/migrations, smallest diff, one runnable check per change, `ponytail:` ceiling comments). Applied here as a docs-only audit.

---

## 6. Final status for the free demo

**No confirmed high or critical findings. No code changes were required by this audit (docs-only).** The public-demo controls at the changed trust boundaries — register closure, RBAC, `@ui.ac.id` enforcement, CORS fail-closed, requestId/error hardening, sanitizer/throttler/botGuard, password-reset non-enumeration design, secret guards, logging redaction, non-root deploy config — are source-verified and backed by unit/structural tests.

**Fixes applied after this audit (controller, same session):**
- **NV-01 — FIXED.** `password-reset.service.ts` no longer rethrows on mail failure; it logs and always returns the generic `{ sent: true }`. Regression test: `test/unit/password-reset-enumeration.test.ts` (mocked failing provider → still `{ sent: true }`).
- **NV-03 — FIXED.** `main.ts` now registers `runtime.onSiblingExit(() => stop())` (with an idempotence guard so SIGTERM + sibling-exit can't double-shutdown), so a dead worker fails the whole process for platform restart.

**Before public launch (owner/Task 8):**
1. **NV-02** — verify Render XFF handling (forged `X-Forwarded-For`); consider user/email-keyed rate limits. Not fixable without a live deployment observation.
2. **NV-04** — run `npm audit --omit=dev` in CI and the full Testcontainers integration suite where Docker is available.
3. Perform the live URL smoke checks (Task 8) — this audit did **not** probe any live endpoint.

The demo is **audit-ready for the documented threat model with the leads above**, and is **not** asserted to be production-secure or OWASP-certified.

---

## 7. Verification evidence (this run)

```
npm run typecheck                         exit 0
npm run lint                              exit 0   (green after removing the skill's .cjs tooling artifact)
npm run test:unit                         14 files, 65 tests passed (inc. reset-enumeration regression)
npx vitest run --config vitest.integration.config.ts \
    test/integration/deploy-config.test.ts   1 file, 10 tests passed  (pure structural; no Docker)
```

Integration tests that boot Postgres/Redis via Testcontainers (e.g. `auth-flow`, `security-hardening`, `admin-invite-and-errors`, `deploy-smoke`) were **not run** — Docker is absent in this environment. Their assertions are cited as source evidence only; they are not claimed as executed here.
