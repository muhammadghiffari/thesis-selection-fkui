import { registerAs } from '@nestjs/config';

export interface AppConfig {
  port: number;
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  /** Email domains allowed for role=student, e.g. ['ui.ac.id'] */
  studentDomains: string[];
  nodeEnv: string;
  isProd: boolean;
  /** Claim window after FIRST OPEN of a magic link (seconds). */
  magicLinkTtlSec: number;
  /** Absolute cap on an unopened emailed link (days). */
  magicLinkMaxAgeDays: number;
  /** stub | resend — stub records sends without hitting an API. */
  mailProvider: 'stub' | 'resend';
  /** CORS allowlist (comma-separated origins). Empty = same-origin + dev default. */
  corsOrigins: string[];
  /** Public base URL for emailed links + CORS fallback. */
  appUrl: string;
  /** Trust X-Forwarded-* from exactly one proxy hop (load balancer / CDN in front). */
  trustProxy: boolean;
  /** Optional alert sink — generic webhook (Slack/Teams) + optional email. Empty = log-only. */
  alertWebhookUrl: string;
  alertEmail: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function parseStudentDomains(raw: string | undefined): string[] {
  return (raw ?? 'ui.ac.id')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

export function parseOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

export const appConfig = registerAs('app', (): AppConfig => {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const isProd = nodeEnv === 'production';
  const jwtSecret = requireEnv('JWT_SECRET');
  // OWASP A02/A07: refuse to boot production with a weak/default secret.
  if (isProd && (jwtSecret === 'dev-only-change-me' || jwtSecret.length < 32)) {
    throw new Error('JWT_SECRET must be >=32 chars in production (refusing weak/default secret)');
  }
  const appUrl = (process.env.APP_URL ?? '').replace(/\/$/, '');
  const origins = parseOrigins(process.env.CORS_ORIGINS);
  if (isProd && origins.length === 0 && appUrl) origins.push(appUrl);
  // Same-origin dev default (vite proxy + api on :3000/:3001) so local dev keeps working.
  if (!isProd && origins.length === 0) origins.push('http://localhost:5173', 'http://localhost:3000', 'http://localhost:3001');
  return {
    port: Number(process.env.PORT ?? 3000),
    databaseUrl: requireEnv('DATABASE_URL'),
    redisUrl: requireEnv('REDIS_URL'),
    jwtSecret,
    studentDomains: parseStudentDomains(process.env.STUDENT_DOMAINS),
    nodeEnv,
    isProd,
    magicLinkTtlSec: Number(process.env.MAGIC_LINK_TTL_SEC ?? 900),
    magicLinkMaxAgeDays: Number(process.env.MAGIC_LINK_MAX_AGE_DAYS ?? 30),
    mailProvider:
      process.env.MAIL_PROVIDER === 'resend' || process.env.RESEND_API_KEY ? 'resend' : 'stub',
    corsOrigins: origins,
    appUrl,
    trustProxy: process.env.TRUST_PROXY === 'true' || (isProd && process.env.TRUST_PROXY !== 'false'),
    alertWebhookUrl: process.env.ALERT_WEBHOOK_URL ?? '',
    alertEmail: process.env.ALERT_EMAIL ?? '',
  };
});
