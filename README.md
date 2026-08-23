# Thesis Selection Platform (FKUI)

Fair, fast, atomic first-come-first-served thesis title selection for 300+
concurrent medical students. Multi-year reusable via academic periods.
Thesis titles stay secret until opening moment. Each student claims EXACTLY
3 ordered titles.

## Docs
- `AGENTS.md` — agent contract: stack, business rules, module boundaries, DoD
- `docs/PRD.md` — full product requirements (v1.1 FINAL)
- `docs/SCHEMA.sql` — canonical database schema

## Quick Start (after scaffold exists)
```bash
docker compose up -d          # app + postgres(pgvector) + redis
npm run migrate               # drizzle migrations
npm run dev                   # api + web + workers
npm run test:integration      # incl. 100-user same-title race test
