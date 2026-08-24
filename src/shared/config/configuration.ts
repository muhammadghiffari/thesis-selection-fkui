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

export const appConfig = registerAs('app', (): AppConfig => {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  return {
    port: Number(process.env.PORT ?? 3000),
    databaseUrl: requireEnv('DATABASE_URL'),
    redisUrl: requireEnv('REDIS_URL'),
    jwtSecret: requireEnv('JWT_SECRET'),
    studentDomains: parseStudentDomains(process.env.STUDENT_DOMAINS),
    nodeEnv,
    isProd: nodeEnv === 'production',
    magicLinkTtlSec: Number(process.env.MAGIC_LINK_TTL_SEC ?? 900),
    magicLinkMaxAgeDays: Number(process.env.MAGIC_LINK_MAX_AGE_DAYS ?? 30),
    mailProvider:
      process.env.MAIL_PROVIDER === 'resend' || process.env.RESEND_API_KEY ? 'resend' : 'stub',
  };
});
