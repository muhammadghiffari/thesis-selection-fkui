# Deploy & Runbook — Thesis Selection FKUI

## 1. Stack (single Render service)
- `api` — NestJS + built SPA (`web/dist` served same-origin), port 3000
- `worker` — BullMQ processors run in the **same process** as API (free Render has no separate worker service)
- external:
  - `postgres` — Neon free Postgres (bring pgvector extension)
  - `redis` — Upstash free (TLS URL, e.g., `rediss://...`)
- optional: `resend` for magic links; `groq` for support chat

The LB/CDN in front terminates TLS. The app trusts **one** proxy hop
(`TRUST_PROXY=true`) so `X-Forwarded-For` maps to the real client IP (Render sets this by default).

## 2. Secrets (production, user-owned)
Generate and store in your secret manager — never commit `.env`:

```bash
openssl rand -hex 32   # JWT_SECRET (must be >= 32 chars; server refuses weak secrets)
```

Required env: `JWT_SECRET`, `DATABASE_URL`, `REDIS_URL`.
Recommended: `APP_URL=https://thesis.fkui.ac.id` (drives CORS + emailed links),
`CORS_ORIGINS=` (leave empty to derive from `APP_URL`),
`ALERT_WEBHOOK_URL=` (Slack/Teams generic webhook), `RESEND_API_KEY=` +
`MAIL_FROM=` for real email, `GROQ_API_KEY=` for the support LLM,
`DB_POOL_MAX=20` (bounded per-process pool, integer 1..50 — lower it to 5–10 if
Neon free reports "too many connections"; API + 3 workers each open one pool).

## 3. Account setup + first deploy (Free Render, user-owned infra)

1. **Create external services (free tiers):**
   - Neon: create a Postgres project; enable the `vector` (pgvector) extension; copy the connection string → `DATABASE_URL`.
   - Upstash: create a Redis database (TLS); copy the `rediss://...` URL → `REDIS_URL`.
2. **Connect the repo to Render:** Render Dashboard → New → Blueprint → select this branch (or `main`) using `render.yaml`. The blueprint defines ONE free web service (`thesis-selection-fkui`), built from the repo `Dockerfile`, port injected via `PORT`, health path `/api/health`.
3. **Fill secret env vars in the Render dashboard** (never in the repo/chat): `DATABASE_URL`, `REDIS_URL`, `APP_URL` (your public URL), `CORS_ORIGINS` + `SOCKET_ORIGINS` (same URL), `JWT_SECRET` (or use the generated value), `RESEND_API_KEY` + `MAIL_FROM` (verified sender) for magic-link email; optionally `GROQ_API_KEY`, `ALERT_WEBHOOK_URL`.
4. **Deploy.** On boot the container runs `migrate-cli.js` then starts the API + BullMQ workers in one process. Health: `curl -fsS https://<your-url>/api/health`.
5. **Seed the first admin** via the Neon SQL editor using an Argon2id hash generated locally — no password is shipped in the repo:
   ```sql
   INSERT INTO users (email, role, password_hash)
   VALUES ('admin@fkui.ac.id', 'admin', '<argon2id-hash-generated-locally>');
   ```

For local development only (not the public demo):
```bash
cp .env.example .env   # then fill secrets
docker compose up -d --build
curl -fsS http://localhost:3000/api/health
```

Migrations run automatically on container start (`migrate-cli.js`).
For the public Render demo, seed the first admin via Neon SQL (see §3) and do not ship a real password in the repo.

## 4. Rate limiting
- **App-layer (Redis-backed, used by free Render):** default 2000/min/IP; `/api/auth/*` 60–120/min; reset 10/min; war catalog 180/min/user; claims 30/min/user; health probes exempt.
- **Edge/LB (if you add a custom/record domain in future):** add per-IP caps (e.g., 300/min general, 20/min `/api/auth/*`, 429+`Retry-After`) in Render/CDN if desired; not available on the default free onrender.net domain without user domains.

## 5. Backup & rollback (free Render)
- Free Render offers no auto-backup; use Neon Console to make DB dumps, or redeploy the repo.
- **Before every deploy:** `./scripts/backup.sh ./backups/pre-<release>`
- **On failure:** `./scripts/rollback.sh <previous-git-sha> ./backups/pre-<release>`
  1. Code is rolled back first (tagged image rebuild), then data is restored —
     Drizzle migrations are forward-only, so data must match the old image.
  2. If the release had a migration, do NOT try to "roll back" only code:
     restore the pre-deploy backup and redeploy the previous image.
- Retain backups for at least 30 days.

## 6. Alerts (optional)
`ALERT_WEBHOOK_URL` receives fire-and-forget JSON alerts (throttled 1/5 min per
kind) for: unhandled 5xx, HIGH integrity flags, plus HIGH-flag emails to
admins/lecturers. Set it in `.env` — empty means log-only (local dev).

## 7. Security checklist (post-deploy verify, public demo)
- [ ] `curl -i https://host/api/health` → `X-Robots-Tag`, CSP, HSTS headers present
- [ ] `curl -i -H 'User-Agent: GPTBot' https://host/api/health` → `403` blocked; `-H 'User-Agent: Mozilla/5.0'` passes
- [ ] `GET https://host/api/admin/students` without token → `401`
- [ ] `GET https://host/unknown` → SPA **404** page (or clean app fallback)
- [ ] `POST /api/auth/login` ×6 with bad password → `429` after 5 failures
- [ ] `POST /api/auth/register` → `404` — public student self-registration is
  closed; students are enrolled via the admin students module (import + magic-link
  actions) and reach the app through scheduled magic links (AGENTS.md product rules)
- [ ] `POST /api/auth/login` for any seeded student → `401` (password login is
  admin/lecturer only, by design)
- [ ] `POST /api/auth/forgot-password` for unknown email → `200 {sent:true}` (no enumeration)
- [ ] CORS: `OPTIONS` from disallowed origin → rejected; allowed origin passes (Note: new free Render URLs often require platform-level CORS tooling since the app relies on an allowlist)
- [ ] `GET /robots.txt` allows `/` but disallows `/api/`, `/magic/`, staff paths, and AI bots
- [ ] Public `GET /auth/register` → `404` (closed; only admin/import students + scheduled magic links)

## 8. Known limits (intentional, free-tier)
- No public student registration; only admin-provisioned/imported students via scheduled magic links.
- TOTP column exists but enrollment flow is not wired (staff log in with Argon2id + rate limits + optional future TOTP). Password reset is wired for staff.
- Render free may suspend the service after idle; BullMQ delayed jobs can pause while the free service is down. Upstash Free may suspend/rate-limit.
- IP-based throttle is per-instance Redis — scale by keeping a shared Redis
  (compose already does) and letting the LB enforce the strict edge cap.

## 9. Render (free) account setup

`render.yaml` links the repo as one free web service (`thesis-selection-fkui`).
Render free has no separate worker service — the app runs API + BullMQ workers
in one shared process.

1. **Connect the repo** — Render Dashboard → *New Web Service* → *From Blueprint*
   → select the `thesis-selection-fkui` repo → branch `main` → link the blueprint.
   The blueprint sets: `runtime: docker`, `plan: free`, `region: oregon`,
   `dockerfilePath: ./Dockerfile`, health path `/api/health`, start command
   `sh -c "node dist/src/shared/db/migrate-cli.js && exec node dist/src/main.js"`
   (migrate + API+worker in one process).

2. **Create/connect Postgres (Neon) and Redis (Upstash)** — external, user-managed:
   - Neon: create a free Postgres; run `CREATE EXTENSION vector;` (pgvector).
   - Upstash: create a free Redis; use its URL (TLS, `rediss://`).
   - Paste `DATABASE_URL` and `REDIS_URL` into the service's Environment
     Variables — the blueprint marks both as user variables (`sync: false`).

3. **Fill secret env vars** (set in the Render dashboard — never commit real values):
   - `APP_URL=https://thesis-selection-fkui.onrender.com` (the real public URL).
   - `CORS_ORIGINS=https://thesis-selection-fkui.onrender.com` — the URL allowlist.
     (The Socket.IO gateway reads the same `CORS_ORIGINS` allowlist.)
   - `JWT_SECRET` — the blueprint has `generateValue: true`; the app refuses weak
     secrets in production (≥ 32 chars).
   - `RESEND_API_KEY` + `MAIL_FROM` — real email (e.g. `noreply@fkui.ac.id`).
   - `GROQ_API_KEY` — optional support-chat LLM key; `ALERT_WEBHOOK_URL` — optional sink.
   - `TRUST_PROXY=true` — set by the blueprint (Render terminates TLS).

4. **URL mapping** — `APP_URL` drives emailed links + CORS fallback;
   `CORS_ORIGINS` is an allowlist (no wildcard); unknown paths serve the built
   SPA (`GET /unknown` → `index.html` app-level fallback). Health: `/api/health`
   (blueprint `healthCheckPath` + Dockerfile HEALTHCHECK).

5. **Email provider** — Resend behind the provider interface
   (`src/shared/notifications/email-provider.ts`); `RESEND_API_KEY` + `MAIL_FROM`
   enable it. Stub mode records sends without calling the API.

6. **Post-deploy smoke** (verify the first deploy):
   ```bash
   curl -fsS https://thesis-selection-fkui.onrender.com/api/health
   curl -i https://thesis-selection-fkui.onrender.com/api/health   # CSP/HSTS/X-Robots-Tag
   curl -i https://thesis-selection-fkui.onrender.com/unknown     # SPA fallback page
   ```
   See §10 for the runtime smoke checklist and expected responses.

## 10. Deployable demo checklist (free Render + Neon + Upstash)

All infra is user-owned; no credentials live in this repo.

**Pre-deploy**
- [ ] `render.yaml` targets the demo branch; repo has no real secrets or `.env`.
- [ ] Neon project has `CREATE EXTENSION vector;` and its URL is pasted as `DATABASE_URL` (`sync: false`).
- [ ] Upstash URL is a TLS `rediss://...` pasted as `REDIS_URL` (`sync: false`); ioredis consumes it as-is, no localhost fallback in production paths.
- [ ] `JWT_SECRET` is ≥32 random chars (`openssl rand -hex 32`), Render-generated or set manually.
- [ ] `APP_URL`, `CORS_ORIGINS`, `SOCKET_ORIGINS` all name the exact public origin (no wildcard).
- [ ] `MAIL_PROVIDER=resend` + verified `RESEND_API_KEY`/`MAIL_FROM`, or accept stub mode (links logged only). `GROQ_API_KEY`/`ALERT_WEBHOOK_URL` set or intentionally empty.
- [ ] `DB_POOL_MAX` left at default 20 (bounded 1..50); no load test against the free demo.

**First boot / first admin**
- The first deploy auto-runs `migrate-cli.js`, then API + BullMQ workers in one process. Expected log: `Migrations applied`. Nothing else is seeded automatically, and titles stay secret until `opens_at`.
- Seed one admin via the Neon SQL editor (Argon2id hash generated locally — see §3); no password ships in the repo. Confirm `POST /api/auth/login` succeeds.

**Smoke URLs / expected messages**
- `GET /api/health` → HTTP 200, `{"status":"ok","info":{"database":{"status":"up"},"redis":{"status":"up"}},...}`. HTTP 503 / `status:"error"` → check the `error` field (DB or Redis down).
- `GET /unknown` → built SPA fallback; `GET /robots.txt` disallows `/api/`, `/magic/`, staff paths. Re-run the §7 security checks (headers, bot blocking, closed register, 429).

**Quota expectations & sleep**
- Render free idles out after ~15 min; the first request after sleep is a cold start (tens of seconds), and delayed BullMQ jobs (swap grace, magic-link stages) pause until wake.
- Neon free has compute/connection caps — at pool 20 × 4 processes you are near the ceiling; lower `DB_POOL_MAX` on "too many connections".
- Upstash free has a daily command cap and request rate limit (realtime pub/sub + queues count). Alerts throttle to 1 per 5 min per kind.

**Escalation**
- Health 503 → Render logs (`Migrations applied`), then Neon/Upstash dashboards; verify URLs and the `vector` extension.
- Admin 401/403 → re-seed a real Argon2id hash via SQL. CORS/socket failures → align `APP_URL`/`CORS_ORIGINS`/`SOCKET_ORIGINS`.
- Any pre-`opens_at` title exposure → treat as a secrecy incident: suspend the service and notify maintainers.

**Stop / remove the demo**
- Render: suspend or delete the web service; Neon: pause/delete the project; Upstash: delete the database. Remove any local `.env` or backups. The repo keeps no secrets.

## 11. Handoff status (read me)

This repository was prepared to be deployable; **no live Render/Neon/Upstash resources were created by the agent** and no URL is asserted here. Deployment is a user-owned step: connect this branch in Render, create the Neon/Upstash free services, paste the secrets (§2/§9), then run the §10 checklist against your own URL.

Known, accepted free-tier limits (not defects): Render idle sleep pauses delayed BullMQ jobs; Neon/Upstash free quotas can suspend under load; the mail sender must be verified in Resend for magic links to actually arrive. The scoped security audit (`docs/superpowers/audits/2026-11-21-free-render-demo.md`) found no confirmed high/critical issues; its remaining leads (NV-02 XFF handling, NV-04 dependency CVE scan) require a live deployment / CI to resolve. This is a demo, not a production or "fully secure"/OWASP-certified system.
