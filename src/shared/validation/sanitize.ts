import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';

/**
 * OWASP A03 (Injection) defense-in-depth: recursive string sanitizer for all
 * inbound bodies/queries. Runs as an interceptor BEFORE the global
 * ValidationPipe so class-validator sees already-clean data.
 * - Strips NUL + control chars (log/config injection, null-byte).
 * - HTML tags are stripped so stored-XSS cannot survive even if a future
 *   renderer forgets to escape (frontend renders text, email is escaped).
 *
 * DB safety stays parameterized (Drizzle) — this is layer 2, not the
 * primary defense. Length caps remain on DTOs; this pipe also hard-caps
 * any single string at 20k and any array length at 5k as a DOS backstop.
 */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const HTML_TAG = /<[^>]*>/g;
const MAX_STR = 20_000;
const MAX_ARR = 5_000;

export function sanitizeString(value: string): string {
  return value.replace(CONTROL, '').replace(HTML_TAG, '').slice(0, MAX_STR).trim();
}

export function sanitizeValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return sanitizeString(value);
  if (Array.isArray(value)) {
    if (value.length > MAX_ARR) value.length = MAX_ARR;
    return value.map((v) => sanitizeValue(v, depth + 1));
  }
  if (value && typeof value === 'object' && depth < 8) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      (value as Record<string, unknown>)[k] = sanitizeValue(v, depth + 1);
    }
    return value;
  }
  return value;
}

@Injectable()
export class SanitizeInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    try {
      const req = ctx.switchToHttp().getRequest<{
        body?: unknown;
        query?: unknown;
        params?: unknown;
      }>();
      if (req?.body) sanitizeValue(req.body);
      if (req?.query) sanitizeValue(req.query);
      // Params are UUID/ids validated by pipes/routes; sanitize for safety.
      if (req?.params) {
        for (const k of Object.keys(req.params)) {
          const v = (req.params as Record<string, unknown>)[k];
          if (typeof v === 'string') {
            (req.params as Record<string, unknown>)[k] = sanitizeString(v);
          }
        }
      }
    } catch {
      // Sanitizer must never break a request path.
    }
    return next.handle();
  }
}
