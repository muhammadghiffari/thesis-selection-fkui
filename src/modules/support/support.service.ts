import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { AuditService } from '../../shared/audit/audit.service.js';
import { DATABASE, type Database } from '../../shared/db/db.module.js';
import {
  periodEnrollments,
  selectionPeriods,
  students,
  supportTickets,
  theses,
  thesisSelections,
  users,
} from '../../shared/db/schema.js';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from '../../shared/embeddings/embeddings-infra.module.js';
import { LLM_PROVIDER, type LlmProvider } from '../../shared/llm/llm-provider.js';
import { MAGIC_RESEND_PORT, type MagicResendPort } from '../../shared/ports/magic-resend.port.js';
import { RULE_CHUNKS } from './rules-content.js';
import type { AuthUser } from '../identity/auth-user.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatResponse {
  answer: string;
  isFallback: boolean;
  /** The matched rule category for display */
  matchedCategory: string | null;
}

export interface StatusCheckResult {
  periodName: string;
  periodStatus: string;
  opensAt: string | null;
  closesAt: string | null;
  selectionCount: number;
  requiredSelections: number;
  /** Never includes thesis titles — only counts and priorities */
  priorities: number[];
}

export interface TicketCreateInput {
  subject: string;
  initialMessage: string;
  channel: 'ai_chat' | 'human' | 'whatsapp';
  context?: Record<string, unknown>;
}

@Injectable()
export class SupportService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @Inject(MAGIC_RESEND_PORT) private readonly magicResend: MagicResendPort,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // RAG SEED — called once at app startup to embed all rule chunks
  // ─────────────────────────────────────────────────────────────────────────

  async seedChunks(): Promise<{ upserted: number }> {
    let upserted = 0;
    for (const chunk of RULE_CHUNKS) {
      const embedding = await this.embeddings.embed(chunk.content);
      const vecLit = `[${embedding.join(',')}]`;
      await this.db.execute(sql`
        INSERT INTO support_chunks (id, category, content, embedding, updated_at)
        VALUES (${chunk.id}, ${chunk.category}, ${chunk.content}, ${vecLit}::vector, now())
        ON CONFLICT (id) DO UPDATE
          SET category   = EXCLUDED.category,
              content    = EXCLUDED.content,
              embedding  = EXCLUDED.embedding,
              updated_at = EXCLUDED.updated_at
      `);
      upserted++;
    }

    // Force Postgres to update table statistics. 
    // This prevents the query planner from using the ivfflat index 
    // (which was created on an empty table and thus might return 0 rows for small datasets)
    await this.db.execute(sql`ANALYZE support_chunks`);

    return { upserted };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RAG CHAT
  // ─────────────────────────────────────────────────────────────────────────

  async chat(
    userMessage: string,
    history: ChatMessage[],
    actor: AuthUser,
  ): Promise<ChatResponse> {
    // 1. Embed the query
    const queryEmbedding = await this.embeddings.embed(userMessage);
    const vecLit = `[${queryEmbedding.join(',')}]`;

    // 2. Retrieve top-1 matching chunk by cosine similarity
    const rows = await this.db.execute<{ id: string; category: string; content: string }>(sql`
      SELECT id, category, content
      FROM support_chunks
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> ${vecLit}::vector
      LIMIT 1
    `);

    const topChunk = rows.rows[0];
    const contextChunk = topChunk?.content ?? '';
    const matchedCategory = topChunk?.category ?? null;

    // 3. Build LLM messages from history + new question
    const llmMessages = [
      ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user' as const, content: userMessage },
    ];

    // 4. Call LLM (never throws — falls back to stub internally)
    const completion = await this.llm.complete(llmMessages, contextChunk);

    // 5. Defense-in-depth: strip any thesis titles from the answer
    const sanitized = await this.sanitizeTitles(completion.content, actor);

    return {
      answer: sanitized,
      isFallback: completion.isFallback,
      matchedCategory,
    };
  }

  /**
   * Strips thesis titles from an LLM answer as a defense-in-depth measure.
   * Titles for the active period of the actor's latest enrollment are fetched
   * if the period is still not open, and replaced with [REDACTED].
   */
  private async sanitizeTitles(text: string, actor: AuthUser): Promise<string> {
    // Only need to sanitize if student role — admin/lecturer can see titles
    if (actor.role !== 'student') return text;

    // Find latest enrollment
    const [studentRow] = await this.db
      .select({ id: students.id })
      .from(students)
      .where(eq(students.userId, actor.sub))
      .limit(1);
    if (!studentRow) return text;

    // Find any period whose opens_at is in the future (where secrecy applies)
    const secretPeriods = await this.db
      .select({ id: selectionPeriods.id })
      .from(periodEnrollments)
      .innerJoin(selectionPeriods, eq(selectionPeriods.id, periodEnrollments.periodId))
      .where(
        and(
          eq(periodEnrollments.studentId, studentRow.id),
          sql`${selectionPeriods.opensAt} > now()`,
        ),
      );

    if (secretPeriods.length === 0) return text; // no secret periods → safe

    // Fetch titles for those secret periods
    const secretPeriodIds = secretPeriods.map((p) => p.id);
    const titleRows = await this.db
      .select({ title: theses.title })
      .from(theses)
      .where(
        and(
          sql`${theses.periodId} = ANY(ARRAY[${sql.join(secretPeriodIds.map((id) => sql`${id}::uuid`), sql`, `)}])`,
          isNull(theses.deletedAt),
        ),
      );

    let sanitized = text;
    for (const { title } of titleRows) {
      // Case-insensitive replacement
      sanitized = sanitized.replace(new RegExp(escapeRegex(title), 'gi'), '[REDACTED]');
    }
    return sanitized;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SELF-SERVICE: CHECK STATUS
  // ─────────────────────────────────────────────────────────────────────────

  async checkStatus(actor: AuthUser): Promise<StatusCheckResult> {
    const [studentRow] = await this.db
      .select({ id: students.id })
      .from(students)
      .where(and(eq(students.userId, actor.sub), isNull(students.deletedAt)))
      .limit(1);
    if (!studentRow) throw new NotFoundException('Student profile not found');

    // Find the most relevant enrollment (open or latest scheduled)
    const enrollmentRows = await this.db
      .select({
        periodId: periodEnrollments.periodId,
        periodName: selectionPeriods.name,
        periodStatus: selectionPeriods.status,
        opensAt: selectionPeriods.opensAt,
        closesAt: selectionPeriods.closesAt,
        settings: selectionPeriods.settings,
      })
      .from(periodEnrollments)
      .innerJoin(selectionPeriods, eq(selectionPeriods.id, periodEnrollments.periodId))
      .where(eq(periodEnrollments.studentId, studentRow.id))
      .orderBy(desc(selectionPeriods.createdAt))
      .limit(1);

    if (!enrollmentRows[0]) {
      throw new NotFoundException('No active enrollment found');
    }
    const enrollment = enrollmentRows[0];

    // Count confirmed/taken selections — NEVER return titles (secrecy rule)
    const selectionRows = await this.db
      .select({ priority: thesisSelections.priority })
      .from(thesisSelections)
      .where(
        and(
          eq(thesisSelections.studentId, studentRow.id),
          eq(thesisSelections.periodId, enrollment.periodId),
          sql`${thesisSelections.status} IN ('taken', 'swap_requested', 'released_pending')`,
          isNull(thesisSelections.deletedAt),
        ),
      );

    return {
      periodName: enrollment.periodName,
      periodStatus: enrollment.periodStatus,
      opensAt: enrollment.opensAt ? new Date(enrollment.opensAt).toISOString() : null,
      closesAt: enrollment.closesAt ? new Date(enrollment.closesAt).toISOString() : null,
      selectionCount: selectionRows.length,
      requiredSelections: enrollment.settings.required_selections,
      priorities: selectionRows.map((s) => s.priority).sort(),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SELF-SERVICE: RESEND MAGIC LINK
  // ─────────────────────────────────────────────────────────────────────────

  async resendMagicLink(actor: AuthUser): Promise<{ delivered: true }> {
    const [studentRow] = await this.db
      .select({ id: students.id })
      .from(students)
      .where(and(eq(students.userId, actor.sub), isNull(students.deletedAt)))
      .limit(1);
    if (!studentRow) throw new NotFoundException('Student profile not found');

    // Get the most recent enrollment for any non-ended period.
    // Resend makes sense for draft, scheduled, or open periods — only closed/archived are excluded.
    const [enrollment] = await this.db
      .select({ periodId: periodEnrollments.periodId, claimedAt: periodEnrollments.linkClaimedAt })
      .from(periodEnrollments)
      .innerJoin(selectionPeriods, eq(selectionPeriods.id, periodEnrollments.periodId))
      .where(
        and(
          eq(periodEnrollments.studentId, studentRow.id),
          sql`${selectionPeriods.status} NOT IN ('closed', 'archived')`,
        ),
      )
      .orderBy(desc(selectionPeriods.createdAt))
      .limit(1);

    if (!enrollment) {
      throw new BadRequestException('No active period enrollment found to resend link for');
    }
    if (enrollment.claimedAt) {
      throw new BadRequestException('Your access link has already been used. Please use the active session.');
    }

    const result = await this.magicResend.resendForStudent(studentRow.id, enrollment.periodId);

    await this.audit.log(
      { id: actor.sub, role: actor.role },
      'support.resend_magic_link',
      'period_enrollment',
      enrollment.periodId,
      { studentId: studentRow.id },
    );

    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SELF-SERVICE: SWAP GUIDE (static)
  // ─────────────────────────────────────────────────────────────────────────

  getSwapGuide(): {
    summary: string;
    steps: string[];
    rulesLink: string;
    note: string;
  } {
    return {
      summary:
        'A swap request lets you exchange a confirmed thesis title for another one, subject to lecturer or admin approval.',
      steps: [
        'Go to your selection page and find the confirmed title you wish to swap.',
        'Click "Request Swap" on the title card.',
        'Choose a category (wrong pick / interest mismatch / lecturer-schedule issue / other).',
        'Write a reason of at least 20 characters explaining why you want to swap.',
        'Submit the request. You can cancel it any time before a decision is made.',
        'If approved, you have 60 seconds to reclaim the title or it becomes available to others.',
        'Wait for the lecturer or admin decision — you will be notified in-app and via email.',
      ],
      rulesLink: '/rules',
      note: 'Cooldown: 5 minutes between swap requests. Maximum 1 active request at a time.',
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ESCALATION TICKETS
  // ─────────────────────────────────────────────────────────────────────────

  async createTicket(
    actor: AuthUser,
    input: TicketCreateInput,
  ): Promise<{ ticketId: string }> {
    const [studentRow] = await this.db
      .select({ id: students.id })
      .from(students)
      .where(and(eq(students.userId, actor.sub), isNull(students.deletedAt)))
      .limit(1);

    const studentId = studentRow?.id ?? null;

    // Auto-attach context: period + selection count
    let autoContext: Record<string, unknown> = { ...input.context };
    if (studentId) {
      try {
        const status = await this.checkStatus(actor);
        autoContext = {
          ...autoContext,
          periodName: status.periodName,
          periodStatus: status.periodStatus,
          selectionCount: status.selectionCount,
          requiredSelections: status.requiredSelections,
        };
      } catch {
        // best-effort context enrichment — don't fail the ticket creation
      }
    }

    const initialMessages = [
      { role: 'user' as const, content: input.initialMessage, sentAt: new Date().toISOString() },
    ];

    const [ticket] = await this.db
      .insert(supportTickets)
      .values({
        studentId,
        subject: input.subject,
        messages: initialMessages,
        channel: input.channel,
        status: 'open',
        context: autoContext,
      })
      .returning({ id: supportTickets.id });

    if (!ticket) throw new Error('Ticket insert failed');

    await this.audit.log(
      { id: actor.sub, role: actor.role },
      'support.ticket.created',
      'support_ticket',
      ticket.id,
      { channel: input.channel },
    );

    return { ticketId: ticket.id };
  }

  /** Generates a WhatsApp deep-link URL with prefilled context. No API integration. */
  async getWhatsAppLink(actor: AuthUser): Promise<{ url: string }> {
    const number = process.env.SUPPORT_WHATSAPP_NUMBER ?? '';
    if (!number) {
      return { url: 'https://wa.me/' }; // fallback to generic
    }

    let contextText = '';
    try {
      const status = await this.checkStatus(actor);
      contextText =
        `[FKUI Thesis Selection Support]\n` +
        `Period: ${status.periodName} (${status.periodStatus})\n` +
        `Selections: ${status.selectionCount}/${status.requiredSelections}\n` +
        `\nPlease describe your issue:`;
    } catch {
      contextText = '[FKUI Thesis Selection Support]\nPlease describe your issue:';
    }

    const encoded = encodeURIComponent(contextText);
    return { url: `https://wa.me/${number}?text=${encoded}` };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ADMIN: TICKET QUEUE
  // ─────────────────────────────────────────────────────────────────────────

  async listTickets(q: {
    status?: string;
    channel?: string;
    page: number;
    pageSize: number;
  }): Promise<{
    rows: Array<{
      id: string;
      subject: string;
      channel: string;
      status: string;
      studentEmail: string | null;
      createdAt: string;
      resolvedAt: string | null;
    }>;
    total: number;
    page: number;
    pageSize: number;
  }> {
    const pageSize = Math.min(q.pageSize, 100);
    const offset = (q.page - 1) * pageSize;

    const conditions = [sql`TRUE`];
    if (q.status) conditions.push(sql`st.status = ${q.status}`);
    if (q.channel) conditions.push(sql`st.channel = ${q.channel}`);
    const where = sql.join(conditions, sql` AND `);

    const totalRes = await this.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM support_tickets st WHERE ${where}`,
    );
    const total = totalRes.rows[0]?.n ?? 0;

    const rows = await this.db.execute<{
      id: string;
      subject: string;
      channel: string;
      status: string;
      studentEmail: string | null;
      createdAt: string;
      resolvedAt: string | null;
    }>(sql`
      SELECT
        st.id,
        st.subject,
        st.channel,
        st.status,
        u.email AS "studentEmail",
        st.created_at AS "createdAt",
        st.resolved_at AS "resolvedAt"
      FROM support_tickets st
      LEFT JOIN students s ON s.id = st.student_id
      LEFT JOIN users u ON u.id = s.user_id
      WHERE ${where}
      ORDER BY st.created_at DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `);

    return { rows: rows.rows, total, page: q.page, pageSize };
  }

  async resolveTicket(
    ticketId: string,
    note: string,
    actor: { id: string; role: 'admin' },
  ): Promise<{ resolved: true }> {
    if (!note || note.trim().length < 10) {
      throw new BadRequestException('Resolution note must be at least 10 characters');
    }

    const [ticket] = await this.db
      .select({ id: supportTickets.id, status: supportTickets.status })
      .from(supportTickets)
      .where(eq(supportTickets.id, ticketId))
      .limit(1);

    if (!ticket) throw new NotFoundException('Ticket not found');
    if (ticket.status === 'resolved') {
      throw new BadRequestException('Ticket already resolved');
    }

    await this.db
      .update(supportTickets)
      .set({
        status: 'resolved',
        assignedAdminId: actor.id,
        resolvedAt: new Date(),
        // Append the resolution note to messages
        messages: sql`${supportTickets.messages} || ${JSON.stringify([
          { role: 'admin', content: note, sentAt: new Date().toISOString() },
        ])}::jsonb`,
      })
      .where(eq(supportTickets.id, ticketId));

    await this.audit.log(
      { id: actor.id, role: actor.role },
      'support.ticket.resolved',
      'support_ticket',
      ticketId,
      { note },
    );

    return { resolved: true };
  }

  /** Returns the current admin's user ID from the users table. */
  async getAdminUserRecord(userId: string): Promise<{ id: string } | null> {
    const [row] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row ?? null;
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
