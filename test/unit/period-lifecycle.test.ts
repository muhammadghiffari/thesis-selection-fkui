import { describe, expect, it } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { assertTransition, canTransition } from '../../src/modules/periods/lifecycle.js';

describe('period lifecycle', () => {
  it('allows the full valid chain draft→scheduled→open→closed→archived', () => {
    expect(canTransition('draft', 'scheduled')).toBe(true);
    expect(canTransition('scheduled', 'open')).toBe(true);
    expect(canTransition('open', 'closed')).toBe(true);
    expect(canTransition('closed', 'archived')).toBe(true);
  });

  it('rejects invalid jumps with ConflictException (409)', () => {
    expect(canTransition('draft', 'open')).toBe(false);
    expect(canTransition('draft', 'archived')).toBe(false);
    expect(canTransition('scheduled', 'closed')).toBe(false);
    expect(canTransition('closed', 'draft')).toBe(false);
    expect(() => assertTransition('draft', 'open')).toThrow(ConflictException);
  });

  it('archived is terminal', () => {
    expect(canTransition('archived', 'archived')).toBe(false);
    expect(canTransition('archived', 'closed')).toBe(false);
  });
});
