import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { seedStaff, startTestApp, type TestApp } from '../helpers/start-test-app.js';
import Redis from 'ioredis';

/**
 * F10 SUPPORT CHAT — Integration test suite.
 *
 * Covers:
 * - RAG chat endpoint (200, rate limit 429, title secrecy sanitization)
 * - Check status (correct counts, no thesis titles in response)
 * - Resend magic link (success, already-used 400, 5-min rate limit)
 * - Swap guide (static response)
 * - Escalation tickets (create, list, resolve with note, duplicate-resolve 400)
 * - Admin ticket queue (list/filter, resolve mandatory note)
 */

let app: TestApp;
let redis: Redis;

const ADMIN = { email: 'f10-admin@fkui.or.id', password: 'f10-admin-pass' };
let adminToken = '';
let studentToken = '';
let studentId = '';
let periodId = '';
const FP = 'fp-f10-test';

async function loginAdmin(): Promise<string> {
  const res = await fetch(`${app.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

/** Creates a student+enrollment and issues a session token. */
async function createStudentAndLogin(npm: string, periodIdArg: string): Promise<{
  token: string;
  studentId: string;
  userId: string;
}> {
  const userRes = await app.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, role) VALUES (${`${npm}@ui.ac.id`}, 'student') RETURNING id
  `);
  const userId = userRes.rows[0]!.id;

  const studentRes = await app.db.execute<{ id: string }>(sql`
    INSERT INTO students (user_id, npm, full_name, class_type, research_track)
    VALUES (${userId}, ${npm}, ${'Test Student ' + npm}, 'regular', 'clinical')
    RETURNING id
  `);
  const sid = studentRes.rows[0]!.id;

  await app.db.execute(sql`
    INSERT INTO period_enrollments (period_id, student_id)
    VALUES (${periodIdArg}, ${sid})
  `);

  // Issue a session directly via magic-link flow
  const jti = crypto.randomUUID();
  const { JwtService } = await import('@nestjs/jwt');
  const jwt = new JwtService({ secret: process.env.JWT_SECRET ?? 'integration-test-secret' });
  const link = await jwt.signAsync(
    { sub: userId, role: 'student', periodId: periodIdArg, jti },
    { expiresIn: '1h' },
  );
  await app.db.execute(sql`
    UPDATE period_enrollments pe
    SET magic_link_token_hash = encode(sha256(${jti}::bytea), 'hex'),
        link_opened_at = now()
    FROM students s
    WHERE s.id = pe.student_id
      AND pe.period_id = ${periodIdArg}
      AND s.npm = ${npm}
  `);
  const claim = await fetch(`${app.url}/api/magic/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: link, fingerprint: FP }),
  });
  expect(claim.status).toBe(201);
  const { accessToken } = (await claim.json()) as { accessToken: string };
  return { token: accessToken, studentId: sid, userId };
}

beforeAll(async () => {
  app = await startTestApp();
  redis = new Redis(app.redisUrl, { maxRetriesPerRequest: null });
  redis.on('error', () => undefined);

  await seedStaff(app.db, ADMIN.email, ADMIN.password, 'admin');
  adminToken = await loginAdmin();

  // Create a SCHEDULED period (not yet open — for secrecy tests)
  const pRes = await fetch(`${app.url}/api/admin/periods`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: 'F10 Test Period',
      academicYear: '2026',
      opensAt: new Date(Date.now() + 2 * 3600_000).toISOString(), // 2h in future
      closesAt: new Date(Date.now() + 26 * 3600_000).toISOString(),
    }),
  });
  expect(pRes.status).toBe(201);
  const pBody = (await pRes.json()) as { id: string };
  periodId = pBody.id;

  const { token, studentId: sid } = await createStudentAndLogin('f10npm001', periodId);
  studentToken = token;
  studentId = sid;
}, 120_000);

afterAll(async () => {
  await redis.quit();
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// RAG CHAT
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/support/chat', () => {
  it('returns a 200 with answer and matchedCategory for a known topic', async () => {
    const res = await fetch(`${app.url}/api/support/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${studentToken}` },
      body: JSON.stringify({ message: 'How does the lock mechanism work?' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      answer: string;
      isFallback: boolean;
      matchedCategory: string | null;
    };
    expect(typeof body.answer).toBe('string');
    expect(body.answer.length).toBeGreaterThan(0);
    // Stub provider in test env → isFallback = true
    expect(body.isFallback).toBe(true);
    expect(body.matchedCategory).toBeTypeOf('string');
  });

  it('rejects empty message with 400', async () => {
    const res = await fetch(`${app.url}/api/support/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${studentToken}` },
      body: JSON.stringify({ message: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('requires student auth — 401 without token', async () => {
    const res = await fetch(`${app.url}/api/support/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'How do I select a title?' }),
    });
    expect(res.status).toBe(401);
  });

  it('admin token is rejected (student-only endpoint)', async () => {
    const res = await fetch(`${app.url}/api/support/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ message: 'Help' }),
    });
    expect(res.status).toBe(403);
  });

  it('enforces 20/min rate limit', async () => {
    // Flood with 21 requests; at least the 21st should 429
    const key = `support:chat:${studentToken.split('.')[2]?.slice(0, 10) ?? 'unknown'}`;
    // Instead of bruteforcing the HTTP endpoint, manipulate Redis directly
    const { JwtService } = await import('@nestjs/jwt');
    const jwt = new JwtService({ secret: process.env.JWT_SECRET ?? 'integration-test-secret' });
    const decoded = jwt.decode(studentToken) as { sub: string };

    // Set the counter to 20 (limit)
    const redisKey = `support:chat:${decoded.sub}`;
    await redis.set(redisKey, '20', 'EX', 60);

    const res = await fetch(`${app.url}/api/support/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${studentToken}` },
      body: JSON.stringify({ message: 'This should be rate-limited' }),
    });
    expect(res.status).toBe(429);

    // Clean up
    await redis.del(redisKey);
  });

  it('never includes thesis titles in the answer for a pre-open period', async () => {
    // Insert a secret thesis for the scheduled period
    const secretTitle = `ULTRA_SECRET_THESIS_F10_${crypto.randomUUID().slice(0, 8)}`;
    await app.db.execute(sql`
      INSERT INTO theses (period_id, title, track)
      VALUES (${periodId}, ${secretTitle}, 'clinical')
    `);

    const res = await fetch(`${app.url}/api/support/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${studentToken}` },
      body: JSON.stringify({ message: secretTitle }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { answer: string };
    // The raw secret title must NOT appear in the response
    expect(body.answer).not.toContain(secretTitle);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SELF-SERVICE: CHECK STATUS
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/support/actions/check-status', () => {
  it('returns period info and selection count without thesis titles', async () => {
    const res = await fetch(`${app.url}/api/support/actions/check-status`, {
      method: 'POST',
      headers: { authorization: `Bearer ${studentToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      periodName: string;
      periodStatus: string;
      selectionCount: number;
      requiredSelections: number;
      priorities: number[];
    };
    expect(body.periodName).toBe('F10 Test Period');
    expect(body.selectionCount).toBe(0);
    expect(body.requiredSelections).toBe(3);
    expect(Array.isArray(body.priorities)).toBe(true);
    // Ensure no 'title' or 'thesisTitle' field leaks
    expect(Object.keys(body)).not.toContain('title');
    expect(Object.keys(body)).not.toContain('thesisTitle');
    expect(Object.keys(body)).not.toContain('theses');
  });

  it('returns 401 without token', async () => {
    const res = await fetch(`${app.url}/api/support/actions/check-status`, { method: 'POST' });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SELF-SERVICE: SWAP GUIDE
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/support/actions/swap-guide', () => {
  it('returns static swap guide with steps and rulesLink', async () => {
    const res = await fetch(`${app.url}/api/support/actions/swap-guide`, {
      headers: { authorization: `Bearer ${studentToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      summary: string;
      steps: string[];
      rulesLink: string;
      note: string;
    };
    expect(body.rulesLink).toBe('/rules');
    expect(Array.isArray(body.steps)).toBe(true);
    expect(body.steps.length).toBeGreaterThan(0);
    expect(body.summary).toContain('swap');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SELF-SERVICE: RESEND MAGIC LINK
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/support/actions/resend-magic-link', () => {
  it('returns 400 when link already claimed (current session means link was claimed)', async () => {
    // studentToken was issued via /api/magic/claim, so link is consumed
    const res = await fetch(`${app.url}/api/support/actions/resend-magic-link`, {
      method: 'POST',
      headers: { authorization: `Bearer ${studentToken}` },
    });
    // The magic/claim flow sets linkClaimedAt → resend should reject
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/already been used/i);
  });

  it('succeeds for a student whose link has NOT been claimed yet', async () => {
    // Create a fresh student with unclaimed enrollment
    const freshNpm = `f10npm-fresh-${Date.now()}`;
    const freshPeriodRes = await fetch(`${app.url}/api/admin/periods`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        name: 'F10 Resend Test Period',
        academicYear: '2026',
        opensAt: new Date(Date.now() + 3_600_000).toISOString(),
        closesAt: new Date(Date.now() + 27 * 3_600_000).toISOString(),
      }),
    });
    const freshPeriod = (await freshPeriodRes.json()) as { id: string };

    // Create user+student+enrollment directly — do NOT claim the link
    const userRes = await app.db.execute<{ id: string }>(sql`
      INSERT INTO users (email, role) VALUES (${`${freshNpm}@ui.ac.id`}, 'student') RETURNING id
    `);
    const freshUserId = userRes.rows[0]!.id;
    const stuRes = await app.db.execute<{ id: string }>(sql`
      INSERT INTO students (user_id, npm, full_name, class_type, research_track)
      VALUES (${freshUserId}, ${freshNpm}, 'Fresh Student', 'regular', 'clinical')
      RETURNING id
    `);
    const freshStuId = stuRes.rows[0]!.id;
    await app.db.execute(sql`
      INSERT INTO period_enrollments (period_id, student_id)
      VALUES (${freshPeriod.id}, ${freshStuId})
    `);

    // Set a magic link hash so resend can regenerate
    const jti = crypto.randomUUID();
    await app.db.execute(sql`
      UPDATE period_enrollments
      SET magic_link_token_hash = encode(sha256(${jti}::bytea), 'hex')
      WHERE period_id = ${freshPeriod.id} AND student_id = ${freshStuId}
    `);

    // Issue a JWT session directly (bypassing the magic link flow) for this student
    const { JwtService } = await import('@nestjs/jwt');
    const jwt = new JwtService({ secret: process.env.JWT_SECRET ?? 'integration-test-secret' });
    const freshToken = await jwt.signAsync(
      { sub: freshUserId, role: 'student', periodId: freshPeriod.id },
      { expiresIn: '1h' },
    );

    const res = await fetch(`${app.url}/api/support/actions/resend-magic-link`, {
      method: 'POST',
      headers: { authorization: `Bearer ${freshToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { delivered: boolean };
    expect(body.delivered).toBe(true);
  });

  it('enforces 1-per-5min rate limit', async () => {
    const { JwtService } = await import('@nestjs/jwt');
    const jwt = new JwtService({ secret: process.env.JWT_SECRET ?? 'integration-test-secret' });
    const decoded = jwt.decode(studentToken) as { sub: string };
    const redisKey = `support:resend:${decoded.sub}`;
    await redis.set(redisKey, '1', 'EX', 300);

    const res = await fetch(`${app.url}/api/support/actions/resend-magic-link`, {
      method: 'POST',
      headers: { authorization: `Bearer ${studentToken}` },
    });
    expect(res.status).toBe(429);
    await redis.del(redisKey);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ESCALATION TICKETS — Student create
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/support/tickets', () => {
  it('creates a ticket and returns ticketId', async () => {
    const res = await fetch(`${app.url}/api/support/tickets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${studentToken}` },
      body: JSON.stringify({
        subject: 'Cannot claim a title',
        initialMessage: 'I get an error when I try to claim. Please help.',
        channel: 'human',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ticketId: string };
    expect(typeof body.ticketId).toBe('string');
    expect(body.ticketId.length).toBeGreaterThan(0);
  });

  it('rejects ticket with missing subject (400)', async () => {
    const res = await fetch(`${app.url}/api/support/tickets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${studentToken}` },
      body: JSON.stringify({ initialMessage: 'Help me', channel: 'human' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects ticket with too-short initialMessage (400)', async () => {
    const res = await fetch(`${app.url}/api/support/tickets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${studentToken}` },
      body: JSON.stringify({ subject: 'Problem', initialMessage: 'short', channel: 'human' }),
    });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WHATSAPP LINK
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/support/tickets/whatsapp-link', () => {
  it('returns a URL string', async () => {
    const res = await fetch(`${app.url}/api/support/tickets/whatsapp-link`, {
      headers: { authorization: `Bearer ${studentToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(typeof body.url).toBe('string');
    expect(body.url).toMatch(/^https:\/\/wa\.me\//);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN: LIST TICKETS
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/admin/support/tickets', () => {
  it('returns paginated ticket list for admin', async () => {
    // First create a ticket
    await fetch(`${app.url}/api/support/tickets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${studentToken}` },
      body: JSON.stringify({
        subject: 'Admin list test',
        initialMessage: 'This is a test ticket for admin list.',
        channel: 'ai_chat',
      }),
    });

    const res = await fetch(`${app.url}/api/admin/support/tickets?page=1&pageSize=10`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: unknown[];
      total: number;
      page: number;
      pageSize: number;
    };
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.total).toBeGreaterThan(0);
    expect(body.page).toBe(1);
  });

  it('filters by status', async () => {
    const res = await fetch(`${app.url}/api/admin/support/tickets?status=open`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ status: string }> };
    for (const row of body.rows) {
      expect(row.status).toBe('open');
    }
  });

  it('rejects student token with 403', async () => {
    const res = await fetch(`${app.url}/api/admin/support/tickets`, {
      headers: { authorization: `Bearer ${studentToken}` },
    });
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN: RESOLVE TICKET
// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /api/admin/support/tickets/:id/resolve', () => {
  let ticketId = '';

  beforeAll(async () => {
    // Create a ticket to resolve
    const res = await fetch(`${app.url}/api/support/tickets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${studentToken}` },
      body: JSON.stringify({
        subject: 'To be resolved',
        initialMessage: 'Please resolve this ticket in the test.',
        channel: 'human',
      }),
    });
    const body = (await res.json()) as { ticketId: string };
    ticketId = body.ticketId;
  });

  it('resolves a ticket with a mandatory note and returns resolved:true', async () => {
    const res = await fetch(`${app.url}/api/admin/support/tickets/${ticketId}/resolve`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ note: 'Issue resolved: student was able to log in after resend.' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resolved: boolean };
    expect(body.resolved).toBe(true);
  });

  it('rejects resolving with a note shorter than 10 chars', async () => {
    // Create another ticket first
    const createRes = await fetch(`${app.url}/api/support/tickets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${studentToken}` },
      body: JSON.stringify({
        subject: 'Short note test',
        initialMessage: 'Please try to resolve with a short note.',
        channel: 'human',
      }),
    });
    const { ticketId: newId } = (await createRes.json()) as { ticketId: string };

    const res = await fetch(`${app.url}/api/admin/support/tickets/${newId}/resolve`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ note: 'short' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects resolving an already-resolved ticket', async () => {
    // Resolve again
    const res = await fetch(`${app.url}/api/admin/support/tickets/${ticketId}/resolve`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ note: 'Resolving again should fail with 400.' }),
    });
    expect(res.status).toBe(400);
  });

  it('records an audit log entry for the resolve action', async () => {
    // Check audit log for 'support.ticket.resolved'
    const res = await fetch(
      `${app.url}/api/admin/audit?action=support.ticket.resolved&page=1&pageSize=10`,
      { headers: { authorization: `Bearer ${adminToken}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ action: string }> };
    const found = body.rows.some((r) => r.action === 'support.ticket.resolved');
    expect(found).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CHUNK SEEDING
// ─────────────────────────────────────────────────────────────────────────────

describe('support_chunks seeding', () => {
  it('all rule chunks are seeded in the database at startup', async () => {
    const { RULE_CHUNKS } = await import('../../src/modules/support/rules-content.js');
    const rows = await app.db.execute<{ id: string }>(
      sql`SELECT id FROM support_chunks`,
    );
    const seededIds = new Set(rows.rows.map((r) => r.id));
    for (const chunk of RULE_CHUNKS) {
      expect(seededIds.has(chunk.id)).toBe(true);
    }
  });

  it('support_chunks have embeddings (non-null vectors)', async () => {
    const rows = await app.db.execute<{ id: string; has_embedding: boolean }>(
      sql`SELECT id, (embedding IS NOT NULL) AS has_embedding FROM support_chunks`,
    );
    for (const row of rows.rows) {
      expect(row.has_embedding).toBe(true);
    }
  });
});
