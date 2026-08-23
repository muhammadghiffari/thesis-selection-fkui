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
  };
});
