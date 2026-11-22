import type { NextFunction, Request, Response } from 'express';

/**
 * Anti-crawler / anti-bot middleware (OWASP A01 + OWASP Automated Threats).
 * - Known AI/scraper user-agents receive 403 on /api/* (health exempt so
 *   LB probes keep working). Legit browsers (incl. empty-UA curl tests that
 *   set no UA) pass — we only block POSITIVE bot fingerprints.
 * - Adds X-Robots-Tag: noindex, nofollow on authenticated API responses so
 *   search engines never index student data.
 * - robots.txt (web/public) carries the same denylist for search engines.
 */
const BOT_UA =
  /(gptbot|chatgpt-user|claudebot|claude-web|ccbot|google-extended|googlebot|bingbot|bytespider|cohere-ai|meta-externalagent|facebookbot|ia_archiver|yandexbot|baiduspider|duckduckbot|petalbot|applebot|diffbot|mastodon|semrushbot|ahrefsbot|mj12bot|dotbot)/i;

export function botGuard(req: Request, res: Response, next: NextFunction): void {
  const url = req.url ?? '';
  if (url.startsWith('/api/health')) return next();
  if (url.startsWith('/api/')) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  }
  const ua = req.headers['user-agent'] ?? '';
  if (ua && BOT_UA.test(ua)) {
    res.status(403).json({
      statusCode: 403,
      message: 'Automated access is not allowed on this service.',
      timestamp: new Date().toISOString(),
      path: url,
    });
    return;
  }
  next();
}
