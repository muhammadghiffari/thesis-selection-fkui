import { describe, expect, it } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { hashFingerprint, hashToken, MagicTokenService } from '../../src/modules/notifications/magic-token.service.js';

const jwt = new JwtService({ secret: 'test-secret' });
const svc = new MagicTokenService(jwt);

describe('MagicTokenService', () => {
  it('signs and round-trips the payload', async () => {
    const raw = await svc.sign({ sub: 'u1', periodId: 'p1', jti: 'j1' }, new Date(Date.now() + 60_000));
    const payload = await svc.verify(raw);
    expect(payload).toMatchObject({ sub: 'u1', periodId: 'p1', jti: 'j1', role: 'student' });
  });

  it('rejects expired tokens with 401', async () => {
    const raw = await jwt.sign({ sub: 'u1', role: 'student', periodId: 'p1', jti: 'j2' }, { expiresIn: '-10s' });
    await expect(svc.verify(raw)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects tokens missing required claims', async () => {
    const bad = await jwt.sign({ sub: 'u1', role: 'admin' }, { expiresIn: '60s' });
    await expect(svc.verify(bad)).rejects.toThrow(UnauthorizedException);
  });

  it('hashes jti and fingerprints deterministically (sha256)', () => {
    expect(hashToken('a')).toBe(hashToken('a'));
    expect(hashToken('a')).not.toBe(hashToken('b'));
    expect(hashFingerprint('fp-1')).toMatch(/^[0-9a-f]{64}$/);
  });
});
