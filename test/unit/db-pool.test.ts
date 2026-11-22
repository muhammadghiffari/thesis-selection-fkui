import { afterEach, describe, expect, it } from 'vitest';
import { dbPoolMax } from '../../src/shared/db/db.module.js';

/** The one runnable check for the bounded DB_POOL_MAX override. */
describe('dbPoolMax() — bounded DB_POOL_MAX', () => {
  const original = process.env.DB_POOL_MAX;
  afterEach(() => {
    if (original === undefined) delete process.env.DB_POOL_MAX;
    else process.env.DB_POOL_MAX = original;
  });

  it('defaults to 20 when unset', () => {
    delete process.env.DB_POOL_MAX;
    expect(dbPoolMax()).toBe(20);
  });

  it('honors a valid override', () => {
    process.env.DB_POOL_MAX = '8';
    expect(dbPoolMax()).toBe(8);
  });

  it('clamps the ceiling and falls back on invalid values', () => {
    process.env.DB_POOL_MAX = '999';
    expect(dbPoolMax()).toBe(50);
    process.env.DB_POOL_MAX = '0';
    expect(dbPoolMax()).toBe(20);
    process.env.DB_POOL_MAX = 'abc';
    expect(dbPoolMax()).toBe(20);
  });
});
