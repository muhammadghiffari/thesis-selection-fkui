/**
 * CORS allowlist policy — pure + fail-closed (OWASP A05/A01).
 * Kept dependency-free so it is unit-testable without booting Nest or Docker.
 */

type OriginCallback = (
  error: Error | null,
  allow?: boolean | string | RegExp | Array<string | RegExp>,
) => void;

/**
 * Decision only. No Origin (same-origin / server-to-server / curl) is fine;
 * only an exact allowlist entry is fine. Everything else is denied — there is
 * deliberately no wildcard and the rejected origin is never echoed anywhere.
 */
export function isOriginAllowed(origin: string | undefined, allowlist: readonly string[]): boolean {
  if (!origin) return true;
  return allowlist.includes(origin);
}

/**
 * Options for app.enableCors(). A denied origin resolves to `false`, which
 * makes the `cors` middleware skip ALL CORS headers and call next() with no
 * error. The browser blocks the response (no Access-Control-Allow-Origin) and
 * nothing reaches AllExceptionsFilter — so no 500 and no leaked origin.
 */
export function corsOptions(allowlist: readonly string[]) {
  return {
    origin: (origin: string | undefined, callback: OriginCallback): void => {
      callback(null, isOriginAllowed(origin, allowlist));
    },
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id', 'Accept'],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    credentials: false,
    maxAge: 86400,
  };
}
