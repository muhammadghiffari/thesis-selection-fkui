# Deploy & Runbook — Thesis Selection FKUI

## 1. Stack (single compose file)
- `api` — NestJS + built SPA (`web/dist` served same-origin), port 3000
- `worker` — BullMQ processors (no HTTP server; healthcheck is `pgrep`)
- `postgres` — pgvector/pg16
- `redis` — Redis 7 (locks, queues, pub/sub, throttles)

The LB/CDN in front terminates TLS. The app trusts **one** proxy hop
(`TRUST_PROXY=true`) so `X-Forwarded-For` maps to the real client IP.

## 2. Secrets (production)
Generate and store in your secret manager — never commit `.env`:

```bash
openssl rand -hex 32   # JWT_SECRET (must be >= 32 chars; server refuses weak secrets)
```

Required env: `JWT_SECRET`, `DATABASE_URL`, `REDIS_URL`.
Recommended: `APP_URL=https://thesis.fkui.ac.id` (drives CORS + emailed links),
`CORS_ORIGINS=` (leave empty to derive from `APP_URL`),
`ALERT_WEBHOOK_URL=` (Slack/Teams generic webhook), `RESEND_API_KEY=` +
`MAIL_FROM=` for real email, `GROQ_API_KEY=` for the support LLM.

## 3. First deploy
```bash
cp .env.example .env   # then fill secrets
docker compose up -d --build
curl -fsS http://localhost:3000/api/health
```

Migrations run automatically on container start (`migrate-cli.js`).
To seed the first admin (idempotent):
```bash
docker compose exec api node dist/src/scripts/seed-admin.js admin@fkui.ac.id 'CHANGE-ME-strong'
```

## 4. Rate limiting (LB + app)
- LB/CDN edge: enforce per-IP caps (suggested: 300/min general, 20/min `/api/auth/*`,
  60/min `/api/magic/*`, 429 + `Retry-After`).
- App (second layer, Redis-backed, NAT-safe):
  - Global default 2000/min per IP; `/api/auth/*` 60–120/min; reset endpoints 10/min;
    war catalog 180/min/user, heartbeat 120/min/user, claims 30/min/user (existing).
- Health probes are exempt (`@SkipThrottle`).

## 5. Backup & rollback
- **Before every deploy:** `./scripts/backup.sh ./backups/pre-<release>`
- **On failure:** `./scripts/rollback.sh <previous-git-sha> ./backups/pre-<release>`
  1. Code is rolled back first (tagged image rebuild), then data is restored —
     Drizzle migrations are forward-only, so data must match the old image.
  2. If the release had a migration, do NOT try to "roll back" only code:
     restore the pre-deploy backup and redeploy the previous image.
- Retain backups for at least 30 days.

## 6. Alerts
`ALERT_WEBHOOK_URL` receives fire-and-forget JSON alerts (throttled 1/5 min per
kind) for: unhandled 5xx, HIGH integrity flags, plus HIGH-flag emails to
admins/lecturers. Set it in `.env` — empty means log-only (local dev).

## 7. Security checklist (post-deploy verify)
- [ ] `curl -i https://host/api/health` → `X-Robots-Tag`, CSP, HSTS headers present
- [ ] `curl -i -H 'User-Agent: GPTBot' https://host/api/health` → `403` blocked; `-H 'User-Agent: Mozilla/5.0'` passes
- [ ] `GET https://host/api/admin/students` without token → `401`
- [ ] `GET https://host/unknown` → SPA **404** page
- [ ] `POST /api/auth/login` ×6 with bad password → `429` after 5 failures
- [ ] `POST /api/auth/register` → `404` — public student self-registration is
  closed; students are enrolled via the admin students module (import + magic-link
  actions) and reach the app through scheduled magic links (AGENTS.md product rules)
- [ ] `POST /api/auth/login` for any seeded student → `401` (password login is
  admin/lecturer only, by design)
- [ ] `POST /api/auth/forgot-password` for unknown email → `200 {sent:true}` (no enumeration)
- [ ] CORS: `OPTIONS` from disallowed origin → rejected; allowed origin passes
- [ ] `GET /robots.txt` allows `/` but disallows `/api/`, `/magic/`, staff paths, and AI bots

## 8. Known limits (intentional)
- TOTP column exists but enrollment flow is not wired (staff log in with Argon2id
  + rate limits + optional future TOTP). Password reset itself is fully wired.
- IP-based throttle is per-instance Redis — scale by keeping a shared Redis
  (compose already does) and letting the LB enforce the strict edge cap.
