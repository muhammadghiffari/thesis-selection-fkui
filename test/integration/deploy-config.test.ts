// Structural/config tests for the Render free deployment: render.yaml blueprint,
// Dockerfile, and DEPLOY.md runbook. Pure file reads — no cloud mutation.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

function envEntries(yaml: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /- key: (\w+)[\s\S]*?(?=- key:|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(yaml))) out[m[1]] = m[0];
  return out;
}

describe('render.yaml — Render free blueprint', () => {
  const yaml = read('render.yaml');

  it('is one free web service named thesis-selection-fkui', () => {
    expect(yaml.match(/- type: web/g)?.length).toBe(1);
    expect(yaml).toMatch(/type: web/);
    expect(yaml).toMatch(/plan: free/);
    expect(yaml).toMatch(/name: thesis-selection-fkui/);
    expect(yaml).toMatch(/region: \w+/);
  });

  it('builds from the repo Dockerfile and checks /api/health', () => {
    expect(yaml).toMatch(/runtime: docker/);
    expect(yaml).toMatch(/dockerfilePath:\s*\.?\/?Dockerfile/);
    expect(yaml).toMatch(/healthCheckPath:\s*\/api\/health/);
  });

  it('keeps Postgres/Redis external (Neon/Upstash user variables, no hardcoded URLs)', () => {
    expect(yaml).not.toMatch(/^databases:/m); // not Render-managed Postgres
    expect(yaml).toMatch(/Neon/);
    expect(yaml).toMatch(/Upstash/);
    const env = envEntries(yaml);
    for (const key of ['DATABASE_URL', 'REDIS_URL']) {
      expect(env[key], `${key} should be declared`).toBeTruthy();
      expect(env[key]).toMatch(/sync: false/);
      expect(env[key]).not.toMatch(/value:\s*\S/); // user pastes real URL in dashboard
    }
  });

  it('ships no secrets (all secret keys user variables or generated)', () => {
    const env = envEntries(yaml);
    for (const key of ['JWT_SECRET', 'APP_URL', 'CORS_ORIGINS', 'SOCKET_ORIGINS', 'RESEND_API_KEY', 'MAIL_FROM', 'GROQ_API_KEY', 'ALERT_WEBHOOK_URL']) {
      expect(env[key], `${key} should be declared`).toBeTruthy();
      expect(env[key]).toMatch(/sync: false|generateValue: true/);
      expect(env[key]).not.toMatch(/value:\s*\S/);
    }
  });

  it('lets Render inject PORT (no fixed PORT env var)', () => {
    expect(yaml).not.toMatch(/- key: PORT/);
  });
});

describe('Dockerfile — Render free', () => {
  const dockerfile = read('Dockerfile');

  it('builds on Node 22', () => {
    expect(dockerfile).toMatch(/FROM node:22/);
  });

  it('has a Render-tolerant healthcheck on /api/health using the injected PORT', () => {
    expect(dockerfile).toMatch(/HEALTHCHECK/);
    expect(dockerfile).toMatch(/\/api\/health/);
    expect(dockerfile).toMatch(/\$\{?PORT/);
  });

  it('runs migrate + API+BullMQ workers via the shell launcher', () => {
    expect(dockerfile).toMatch(/^CMD \["sh", "-c"/m);
    expect(dockerfile).toMatch(/migrate-cli\.js/);
    expect(dockerfile).toMatch(/exec node dist\/src\/main\.js/);
  });

  it('does not hardcode the port', () => {
    expect(dockerfile).not.toMatch(/ENV PORT=/);
    expect(dockerfile).not.toMatch(/EXPOSE/);
  });
});

describe('DEPLOY.md — account setup', () => {
  const deploy = read('DEPLOY.md');

  it('documents the Render free account setup', () => {
    for (const pat of [
      'Neon', 'Upstash', 'render\\.yaml', 'DATABASE_URL', 'REDIS_URL',
      'APP_URL', 'CORS_ORIGINS', 'SOCKET_ORIGINS', 'RESEND_API_KEY', 'MAIL_FROM', 'api/health',
    ]) {
      expect(deploy).toMatch(new RegExp(pat));
    }
  });
});
