import { randomUUID } from 'node:crypto';
import type { Params } from 'nestjs-pino';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import type { AppConfig } from '../config/configuration.js';

export function buildPinoParams(app: AppConfig): Params {
  return {
    pinoHttp: {
      level: app.isProd ? 'info' : 'debug',
      transport: app.isProd ? undefined : { target: 'pino-pretty', options: { singleLine: true } },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-request-id"]',
          'req.body.password',
          'req.body.refreshToken',
          'req.body.token',
          'req.body.fingerprint',
          'req.body.email',
          'res.headers["set-cookie"]',
        ],
        censor: '[REDACTED]',
      },
      genReqId: (req) =>
        (typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'])
          ? (req.headers['x-request-id'] as string)
          : randomUUID(),
      customProps: (req) => ({ context: 'http', requestId: req.id }),
    },
  };
}

/** Returns a dynamic module; spread into app imports with the parsed config. */
export function loggingModule(app: AppConfig) {
  return PinoLoggerModule.forRoot(buildPinoParams(app));
}
