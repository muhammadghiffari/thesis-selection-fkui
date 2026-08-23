import { describe, expect, it } from 'vitest';
import { QUEUE_NAMES } from './queues.js';

describe('workers harness', () => {
  it('declares exactly the AGENTS.md queue set', () => {
    expect([...QUEUE_NAMES].sort()).toEqual(['email', 'embedding', 'expiry_events', 'export']);
  });
});
