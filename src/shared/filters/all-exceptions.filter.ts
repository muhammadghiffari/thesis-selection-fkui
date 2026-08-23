import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { Request, Response } from 'express';

interface ErrorBody {
  statusCode: number;
  message: string | string[];
  path?: string;
  timestamp: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    @InjectPinoLogger(AllExceptionsFilter.name)
    private readonly logger: PinoLogger,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const raw = exception.getResponse();
      const message =
        typeof raw === 'string'
          ? raw
          : ((raw as { message?: string | string[] }).message ?? exception.message);
      this.send(response, request.url, { statusCode, message, timestamp: new Date().toISOString() });
      return;
    }

    this.logger.error({ err: exception, url: request.url }, 'Unhandled exception');
    this.send(response, request.url, {
      statusCode: 500,
      message: 'Internal server error',
      timestamp: new Date().toISOString(),
    });
  }

  private send(response: Response, path: string | undefined, body: ErrorBody): void {
    response.status(body.statusCode).json({ ...body, path });
  }
}
