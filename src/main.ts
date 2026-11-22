import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import express from 'express';
import { AppModule } from './app.module.js';
import { appConfig } from './shared/config/configuration.js';
import { botGuard } from './shared/security/bot-guard.js';
import { corsOptions } from './shared/security/cors.js';
import { bootWorkersInProcess } from './shared/runtime/worker-lifecycle.js';
import { createEmailProcessor } from '../workers/src/processors/email.js';
import { createExpiryEventsProcessor } from '../workers/src/processors/expiry-events.js';
import { createExportProcessor } from '../workers/src/processors/export.js';

async function bootstrap(): Promise<void> {
  const config = appConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  // Load balancer / CDN in front ⇒ trust exactly one hop for X-Forwarded-*.
  if (config.trustProxy) app.set('trust proxy', 1);

  // OWASP A05 + A01: hardened headers. CSP allows self + Vite assets; inline
  // styles needed for Tailwind utilities; no unsafe-eval, no object/plugin.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'", 'ws:', 'wss:'],
          fontSrc: ["'self'", 'data:'],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
      hsts: config.isProd ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      crossOriginResourcePolicy: { policy: 'same-site' },
      crossOriginOpenerPolicy: { policy: 'same-origin' },
    }),
  );

  // Correlation id for every response (logs + API envelope + X-Request-Id).
  // Only accept a bounded, log-safe client id; otherwise mint one. This keeps
  // newlines/control chars and unbounded strings out of the logs.
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const incoming = req.headers['x-request-id'];
    const id =
      typeof incoming === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(incoming)
        ? incoming
        : randomUUID();
    (req as unknown as { id: string }).id = id;
    res.setHeader('X-Request-Id', id);
    next();
  });

  // OWASP Automated Threats: known AI/scraper UAs get 403 on /api/*.
  app.use(botGuard);

  // CORS: allowlist only, fail-closed. A rejected origin resolves to `false`,
  // so cors emits NO Access-Control-Allow-Origin header and calls next() with
  // no error — the browser blocks the response, no 500/echoed origin leaks via
  // the global filter. Bearer-token auth (no cookies) ⇒ credentials=false;
  // preflight cached for 24h at the edge/LB.
  app.enableCors(corsOptions(config.corsOrigins));

  // OWASP A06 / DOS hardening: bounded JSON bodies + strict validation.
  const json = express.json({ limit: '100kb' });
  const urlencoded = express.urlencoded({ extended: true, limit: '100kb' });
  app.use(json);
  app.use(urlencoded);

  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      transform: true,
      skipMissingProperties: false,
    }),
  );
  const port = Number(process.env.PORT ?? 3000);

  // Production: serve the built SPA from the same process (same-origin ⇒
  // no CORS needed for the frontend; LB terminates TLS + HSTS).
  const webDist = process.env.WEB_DIST ?? join(process.cwd(), 'web-dist');
  if (existsSync(webDist)) {
    app.use(express.static(webDist, { index: false, maxAge: '1d', immutable: true }));
    app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
      const accept = req.headers.accept ?? '';
      if (!accept.includes('text/html') && !accept.includes('*/*')) return next();
      res.sendFile(join(webDist, 'index.html'));
    });
  }

  await app.listen(port, '0.0.0.0');

  // Shared-process mode (Render free tier): this one Node process serves the
  // API and runs the BullMQ workers. The supervisor closes workers + API on
  // shutdown; a non-zero sibling exit code wins for the process exit code.
  const runtime = await bootWorkersInProcess(config.redisUrl, [
    { name: 'email', ...createEmailProcessor() },
    { name: 'expiry_events', ...createExpiryEventsProcessor() },
    { name: 'export', ...createExportProcessor() },
  ]);

  let stopping = false;
  const stop = (): void => {
    if (stopping) return; // SIGTERM + sibling-exit can race; shut down once.
    stopping = true;
    void runtime
      .shutdown()
      .then(() => app.close())
      .then(() => process.exit(runtime.siblingExitCode ?? 0))
      .catch(() => process.exit(1));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  // A worker that dies should not leave /api/health reporting healthy with no
  // workers to drain scheduled jobs — fail the whole process so the platform
  // restarts it (NV-03 from the free-demo audit).
  runtime.onSiblingExit(() => stop());
}

void bootstrap();
