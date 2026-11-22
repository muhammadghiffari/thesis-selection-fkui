import { describe, expect, it, vi } from 'vitest';
import { PasswordResetService } from '../../src/modules/identity/password-reset.service.js';

/**
 * Security regression (audit NV-01): a real staff email with a FAILING mail
 * provider must still get the generic { sent: true } response, otherwise the
 * 500-vs-200 difference enumerates which staff emails exist.
 */
function makeService(sendImpl: () => Promise<never>): {
  service: PasswordResetService;
  auditLog: ReturnType<typeof vi.fn>;
} {
  // Chainable Drizzle-ish query stub: select().from().where().limit() → staff row.
  const staffRow = { id: 'u1', email: 'lecturer@fkui.ac.id', role: 'lecturer' };
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => [staffRow],
  };
  const db = {
    select: () => chain,
    update: () => ({ set: () => ({ where: async () => [] }) }),
    insert: () => ({ values: async () => [] }),
  } as never;

  const redis = {
    get: async () => null,
    incr: async () => 1,
    expire: async () => 1,
  } as never;

  const email = { send: vi.fn(sendImpl) } as never;
  const users = {} as never; // unused on the request path
  const auditLog = vi.fn(async () => undefined);
  const audit = { log: auditLog } as never;

  return { service: new PasswordResetService(db, users, email, redis, audit), auditLog };
}

describe('PasswordResetService.requestReset — no enumeration via mail failure', () => {
  it('returns generic { sent: true } even when the email provider throws', async () => {
    const { service, auditLog } = makeService(async () => {
      throw new Error('resend unavailable');
    });
    // Stub the Nest logger so the expected delivery-failure log stays quiet.
    (service as unknown as { logger: unknown }).logger = {
      error: vi.fn(), log: vi.fn(), warn: vi.fn(), debug: vi.fn(), verbose: vi.fn(),
    };

    await expect(service.requestReset('lecturer@fkui.ac.id', '127.0.0.1')).resolves.toEqual({
      sent: true,
    });
    // The attempt is still audited even though delivery failed.
    expect(auditLog).toHaveBeenCalledWith(
      null,
      'auth.password_reset.requested',
      'user',
      'u1',
      expect.any(Object),
    );
  });
});
