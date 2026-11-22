import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from '../redis/redis.module.js';

/**
 * Lightweight alerting (OWASP A09): fire-and-forget webhook (+ optional
 * email downstream) for 5xx spikes, HIGH integrity flags, health degradation,
 * and auth-abuse signals.
 * - Throttled per kind in Redis (1 per 5 min) so a single incident does not
 *   flood the channel — the incident itself is still in logs/audit.
 * - No-ops gracefully when ALERT_WEBHOOK_URL is unset (local dev).
 * - Never throws into request paths.
 */
@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);
  private readonly webhook: string;
  private readonly emailFallback: string;

  constructor(@Inject(REDIS) private readonly redis: Redis) {
    this.webhook = process.env.ALERT_WEBHOOK_URL ?? '';
    this.emailFallback = process.env.ALERT_EMAIL ?? '';
  }

  async alert(kind: string, message: string, context?: Record<string, unknown>): Promise<void> {
    const ts = new Date().toISOString();
    this.logger.warn({ kind, message, context, ts }, 'alert');
    if (!this.webhook) {
      if (this.emailFallback) this.logger.warn({ to: this.emailFallback }, 'alert email not configured (no mail transport here)');
      return;
    }
    try {
      const key = `alert:${kind}`;
      const seen = await this.redis.get(key);
      if (seen) return; // already alerted recently — logs retain the signal.
      await this.redis.setex(key, 300, '1').catch(() => undefined);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      await fetch(this.webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `[FKUI alert] ${kind}: ${message}` }),
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer));
    } catch (err) {
      this.logger.error({ err }, 'alert delivery failed (non-fatal)');
    }
  }
}
