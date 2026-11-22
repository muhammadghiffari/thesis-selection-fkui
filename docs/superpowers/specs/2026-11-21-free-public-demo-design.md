# Free Public Demo and Readiness Design

## Intent

Make the FKUI thesis-selection app deployable at a public URL for a real, safe-to-try end-to-end demo at $0 ongoing platform cost. The existing project already contains most requested security controls; this work should verify the current implementation and address deployment blockers rather than rebuild those controls. This is a demo, not a production-ready service or a claim of OWASP certification.

## Goals

- Deploy the existing API and SPA on Render's free web-service tier, with BullMQ workers available while the service is awake.
- Use Neon Postgres and Upstash Redis free tiers so primary data and queued work are not tied to the web service's ephemeral filesystem.
- Keep the site publicly reachable but do not enable public registration: students remain limited to admin-provisioned/enrolled `@ui.ac.id` accounts using the existing period-bound scheduled magic-link flow; lecturer/admin provisioning remains privileged.
- Use synthetic period, title, and student test data only; never import real student data into the public demo.
- Provide reproducible setup, secret/configuration guidance, demo bootstrap instructions, smoke checks, and clear free-tier limitations.
- Review authentication/authorization, HTTP errors, input handling, CORS, throttling, password reset, logging/alerts, indexes, rollback, and crawler controls; fix confirmed release blockers within the agreed demo scope.
- Verify builds, tests, deploy configuration, and reachable service behavior where credentials and deployment access allow.
- After implementation, use the requested Cloudflare security-audit and Ponytail skills/reviews, reporting findings and anything their runtime requirements prevent.

## Non-goals and anti-goals

- No production/clinical-data deployment, compliance certification, formal penetration-test claim, or guarantee that the service is "fully secure."
- No weakening authentication, title secrecy, selection rules, or authorization to make the demo easier.
- No general/public self-registration and no bypass of period enrollment or scheduled magic-link rules.
- No paid plan, custom domain, persistent always-on worker, or guarantee of on-time delayed jobs on a sleeping free service.
- Do not overwrite or discard the existing uncommitted user work in the current branch.
- Do not publish real student data or hard-coded demo credentials.

## Constraints and assumptions

- Keep the mandated NestJS/React/Postgres/Redis/BullMQ stack and module boundaries.
- Render free web services sleep after inactivity; first request may be delayed. Jobs may be delayed during sleep and resume when the service wakes.
- Render does not offer a free separate background-worker service. API and worker must share one free web-service runtime; this must be tested for memory/lifecycle behavior and documented.
- Neon Free and Upstash Free have quotas and may suspend/limit service when exhausted. They are suitable for a limited demo, not assured production durability or capacity.
- Actual cloud accounts, credentials, service creation, and DNS are user-owned. Never ask the user to paste secrets into chat or commit them.
- Real email delivery requires the owner to configure a verified sender and provider secret through the hosting dashboard; do not promise real magic-link delivery with the existing stub provider.
- The current working tree has substantial uncommitted changes (including hardening and deployment work). Treat all of it as user-owned; inspect before editing and preserve it.

## Approaches considered

1. **All services on Render Free.** Fewest providers, but Render Postgres expires after 30 days and free Redis is volatile on restart. Rejected for this demo because restarts could lose primary data and queue state.
2. **Render API + worker, Neon Postgres, Upstash Redis (selected).** Better state persistence and Redis compatibility while remaining within free tiers. Since Render has no free worker service, API and workers share one web service; this costs memory and means delayed jobs pause during sleep. Selected because it supports the actual application flows without inventing a new queue implementation.
3. **Static SPA plus independent API/worker providers.** Separates concerns, but requires more free providers, CORS/socket configuration, and more operational failure points. Not selected for the first public demo.

## Design decisions

- Keep the API and SPA same-origin in the existing container image.
- Run the existing BullMQ processors alongside the API in the Render service with explicit lifecycle handling; do not register a fake worker or silently disable scheduled features.
- Connect to Neon and Upstash using TLS-capable connection URLs and configure database pool/Redis behavior to fit managed free-tier limits.
- Provide provider setup instructions and environment-variable mapping. Demo admin initialization must be explicit, secret-driven, idempotent, and removable/disableable; no default password or public bootstrap endpoint. Student test accounts must be explicitly provisioned and enrolled by an administrator, and must satisfy `STUDENT_DOMAINS`.
- Keep demo selection mutations persistent like the real product. Repeat tests using a new cloned demo period and newly provisioned test identities, never through an unauthenticated reset endpoint.
- Readiness threshold: fix all confirmed critical/high-impact remotely exploitable findings and any issue that breaks a core role workflow or risks title secrecy, account compromise, or data integrity before public launch. Fix medium findings when reachable in this public-demo threat model; otherwise document rationale and mitigation. Record low/informational items without expanding scope unless they reveal a business-rule violation.
- Error coverage should verify clean behavior for the statuses used by this app (including 400/401/403/404/409/410/422/429/500). HTTP 402 is not a supported app flow because there is no billing/payment feature; do not invent billing UI just to add an unused status page.
- Keep external account provisioning/manual secrets entry as a documented user step. A live public URL cannot be asserted until a Render account deploys the connected repository.
- Audit current controls against behavior and test coverage. Distinguish confirmed vulnerabilities from hardening notes and free-tier limitations; do not promise blanket "latest OWASP safe."
- Run the requested external security audit and Ponytail review after implementation; record confirmed/unresolved results separately and do not blindly apply automated recommendations.

## Builder-owned choices

- Choose the smallest robust startup/lifecycle mechanism for API + BullMQ workers and leave a runnable check that fails if either process/worker startup handling breaks.
- Choose safe, low-pool-size defaults compatible with the selected free database tiers without changing race/locking semantics.
- Identify any release blocker that cannot be safely solved without a user-provided account, verified email sender, or demo data decision; ask before making a consequential product/security tradeoff.
- Verify end-to-end flows against available test infrastructure and provide exact dashboard steps for anything requiring user credentials.

## Acceptance checks

- Existing strict typecheck, lint, unit and relevant integration tests pass, or known pre-existing/environment failures are clearly reported.
- Container/build/deploy config builds and starts API + workers correctly, exposes the platform-provided port, and handles shutdown without orphaning work.
- `/api/health`, frontend routes/error fallback, auth and role guards, password reset non-enumeration, validation, CORS, rate limiting, and queue-backed flows for the student, lecturer, and admin paths are exercised where test accounts/infrastructure permit; core business rules (including title secrecy, exactly three claims, swaps/review, audit) must remain enforced.
- Deploy guide explains account setup, secret handling, migrations/bootstrap, public smoke checks, sleep/quota behavior, backup/restore limits, and how to stop/remove the demo.
- Student-facing demo remains inaccessible to arbitrary visitors; a valid domain alone is not sufficient without admin provisioning/enrollment and a scheduled single-use magic link.
- No secrets, real student data, or user work are committed or discarded.
- Security audit/Ponytail results are reported with evidence and limits; production readiness is not claimed for the free demo.
