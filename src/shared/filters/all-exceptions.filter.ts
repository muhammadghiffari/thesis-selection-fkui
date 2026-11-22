import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException, Inject, Optional } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { Request, Response } from 'express';
import { AlertsService } from '../alerts/alerts.service.js';

interface ErrorBody {
  statusCode: number;
  code: string;
  message: string | string[];
  path?: string;
  timestamp: string;
  requestId?: string;
}

const CODE_BY_STATUS: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  410: 'GONE',
  422: 'VALIDATION_ERROR',
  429: 'RATE_LIMITED',
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    @InjectPinoLogger(AllExceptionsFilter.name)
    private readonly logger: PinoLogger,
    @Optional() @Inject(AlertsService) private readonly alerts?: AlertsService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>() as Request & {
      id?: string;
      user?: { sub?: string; role?: string };
    };

    if (response.headersSent) return;

    const headerId = request.headers?.['x-request-id'];
    const requestId =
      (request as unknown as { id?: string }).id ??
      (typeof headerId === 'string' ? headerId : undefined);
    const baseUrl = (request as unknown as { baseUrl?: string }).baseUrl;
    const path = baseUrl ? `${baseUrl}${request.url}` : (request.url ?? '');

    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const raw = exception.getResponse();
      const message =
        typeof raw === 'string'
          ? raw
          : ((raw as { message?: string | string[] }).message ?? exception.message);
      const retryAfter =
        typeof raw === 'object' && raw !== null
          ? (raw as { retryAfter?: number }).retryAfter
          : undefined;
      if (statusCode === 429 && typeof retryAfter === 'number') {
        try {
          response.setHeader('Retry-After', String(retryAfter));
        } catch {
          // headers may already be flushed in tests — non-fatal
        }
      }
      this.logSecurity(request, statusCode, path, requestId);
      this.send(response, path, {
        statusCode,
        code: CODE_BY_STATUS[statusCode] ?? 'ERROR',
        message,
        timestamp: new Date().toISOString(),
        ...(requestId ? { requestId } : {}),
      });
      return;
    }

    this.logger.error({ err: exception, url: path, requestId }, 'Unhandled exception');
    void this.alerts
      ?.alert('server-error', `Unhandled exception on ${path}`, { requestId })
      .catch(() => undefined);
    this.send(response, path, {
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      timestamp: new Date().toISOString(),
      ...(requestId ? { requestId } : {}),
    });
  }

  private logSecurity(
    request: Request & { user?: { sub?: string; role?: string } },
    statusCode: number,
    path: string,
    requestId?: string,
  ): void {
    if (statusCode === 401 || statusCode === 403 || statusCode === 429) {
      this.logger.warn(
        {
          statusCode,
          url: path,
          ip: request.ip,
          userId: request.user?.sub ?? null,
          role: request.user?.role ?? null,
          requestId,
        },
        'security: rejected request',
      );
    }
  }

  private send(response: Response, path: string | undefined, body: ErrorBody): void {
    if (response.headersSent) return;
    response.status(body.statusCode).json({ ...body, path });
  }
}
