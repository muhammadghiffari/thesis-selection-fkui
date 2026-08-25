import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConflictException } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DATABASE, type Database } from '../../shared/db/db.module.js';
import { EventBus } from '../../shared/event-bus/event-bus.service.js';
import { exportJobs } from '../../shared/db/schema.js';
import { EMAIL_PROVIDER } from '../../shared/notifications/notifications-infra.module.js';
import type { EmailProvider } from '../../shared/notifications/email-provider.js';
import type { AuthUser } from '../identity/auth-user.js';
import { createExpiryQueue } from '../war/war.tokens.js';
import { ReportBuilder, type ExportKind } from './report-builder.js';

export const EXPORT_DIR = process.env.EXPORT_DIR ?? join(process.cwd(), 'data', 'exports');

const KINDS: ExportKind[] = [
  'final_selections',
  'final_selections_pdf',
  'swap_history',
  'integrity_summary',
];

@Injectable()
export class ReportsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    @Inject(EventBus) private readonly events: EventBus,
  ) {}

  /** Admin-triggered; scoped by role (admins only reach this controller). */
  async request(user: AuthUser, kind: string, periodId: string): Promise<{ jobId: string }> {
    if (!KINDS.includes(kind as ExportKind)) {
      throw new BadRequestException(`Unknown report kind: ${kind}`);
    }
    // duplicate in-flight guard: same requester+kind+period already queued/processing
    const [inFlight] = await this.db
      .select({ id: exportJobs.id })
      .from(exportJobs)
      .where(
        and(
          eq(exportJobs.requestedBy, user.sub),
          eq(exportJobs.kind, kind),
          eq(exportJobs.periodId, periodId),
          eq(exportJobs.status, 'queued'),
        ),
      )
      .limit(1);
    if (inFlight) return { jobId: inFlight.id };

    const [row] = await this.db
      .insert(exportJobs)
      .values({ requestedBy: user.sub, kind, periodId })
      .returning({ id: exportJobs.id });
    if (!row) throw new Error('insert returned no row');

    const queue = createExpiryQueue(process.env.REDIS_URL ?? 'redis://localhost:6379');
    await queue.add(
      'export',
      { type: 'export', jobId: row.id },
      { attempts: 2, backoff: { type: 'exponential', delay: 5000 } },
    );
    return { jobId: row.id };
  }

  /** Worker entry — processes the file then notifies exactly once. */
  async processJob(jobId: string): Promise<{ status: string }> {
    const [job] = await this.db.select().from(exportJobs).where(eq(exportJobs.id, jobId)).limit(1);
    if (!job) throw new NotFoundException('job not found');
    if (job.status === 'ready') return { status: 'ready' }; // retry no-op

    await this.db
      .update(exportJobs)
      .set({ status: 'processing' })
      .where(and(eq(exportJobs.id, jobId), eq(exportJobs.status, 'queued')));

    try {
      const builder = new ReportBuilder(this.db, job.periodId);
      const { buffer, filename } = await builder.build(job.kind as ExportKind);
      await mkdir(EXPORT_DIR, { recursive: true });
      const filePath = join(EXPORT_DIR, `${jobId}-${filename}`);
      await writeFile(filePath, buffer);

      // atomic ready-claim: a retry after completion is a no-op
      const claimed = await this.db
        .update(exportJobs)
        .set({ status: 'ready', filePath, completedAt: new Date() })
        .where(and(eq(exportJobs.id, jobId), eq(exportJobs.status, 'processing')))
        .returning({ id: exportJobs.id });
      if (claimed.length === 0) return { status: 'ready' };

      await this.notifyReadyOnce(job.requestedBy, jobId, job.kind);
      return { status: 'ready' };
    } catch (err) {
      await this.db
        .update(exportJobs)
        .set({ status: 'failed', error: String(err), completedAt: new Date() })
        .where(eq(exportJobs.id, jobId));
      throw err;
    }
  }

  /** In-app (persisted + realtime push) + email fallback — once per job. */
  private async notifyReadyOnce(userId: string, jobId: string, kind: string): Promise<void> {
    const already = await this.db.execute(sql`
      SELECT 1 FROM notification_deliveries
      WHERE template = 'export_ready' AND payload->>'jobId' = ${jobId}
      LIMIT 1
    `);
    if (already.rows.length > 0) return;

    const [delivery] = await this.db.execute(sql`
      INSERT INTO notification_deliveries (user_id, channel, template, payload, status)
      VALUES (${userId}, 'in_app', 'export_ready', ${JSON.stringify({ jobId, kind })}::jsonb, 'sent')
      RETURNING id
    `).then((r) => r.rows as Array<{ id: string }>);

    await this.redisPublish(
      JSON.stringify({
        event: 'notification',
        room: `user:${userId}`,
        payload: { kind: 'export_ready', jobId, reportKind: kind },
      }),
    );

    const [user] = await this.db.execute(sql`
      SELECT email FROM users WHERE id = ${userId}
    `).then((r) => r.rows as Array<{ email: string }>);

    if (user) {
      try {
        await this.email.send({
          to: user.email,
          subject: `Your ${kind} report is ready`,
          body: `<p>Download it from the admin → reports page.</p><p>Job: ${jobId}</p>`,
          deliveryId: delivery?.id,
        });
      } catch {
        // delivery row stays 'sent' for the in-app part; email failures are non-fatal here
      }
    }
  }

  private async redisPublish(message: string): Promise<void> {
    const redis = (await import('ioredis')).default;
    const client = new redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
    try {
      await client.connect();
      await client.publish('realtime:events', message);
    } finally {
      client.disconnect();
    }
  }

  async download(user: AuthUser, jobId: string): Promise<{ buffer: Buffer; filename: string }> {
    const [job] = await this.db.select().from(exportJobs).where(eq(exportJobs.id, jobId)).limit(1);
    if (!job) throw new NotFoundException('Report not found');
    if (job.requestedBy !== user.sub && user.role !== 'admin') {
      throw new ForbiddenException('Not your report');
    }
    if (job.status !== 'ready' || !job.filePath) {
      throw new ConflictException(`Report is ${job.status}`);
    }
    // path traversal guard: id is a uuid we generated; keep a belt anyway
    if (!job.filePath.startsWith(EXPORT_DIR)) throw new ForbiddenException('Invalid path');
    const buffer = await readFile(job.filePath);
    return { buffer, filename: job.filePath.split('/').pop() ?? 'report' };
  }

  async listMine(user: AuthUser): Promise<Array<Record<string, unknown>>> {
    return this.db
      .select({
        id: exportJobs.id,
        kind: exportJobs.kind,
        status: exportJobs.status,
        periodId: exportJobs.periodId,
        createdAt: exportJobs.createdAt,
        completedAt: exportJobs.completedAt,
        error: exportJobs.error,
      })
      .from(exportJobs)
      .where(eq(exportJobs.requestedBy, user.sub))
      .orderBy(desc(exportJobs.createdAt))
      .limit(50);
  }
}
