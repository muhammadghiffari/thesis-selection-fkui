import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIMENSIONS, HashingEmbeddingProvider } from '../../src/shared/embeddings/embedding-provider.js';

describe('HashingEmbeddingProvider', () => {
  const provider = new HashingEmbeddingProvider();

  it('returns a 1536-dim L2-normalized vector', async () => {
    const v = await provider.embed('clinical trial design in community settings');
    expect(v.length).toBe(EMBEDDING_DIMENSIONS);
    const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('is deterministic and order-sensitive', async () => {
    const a = await provider.embed('malaria prevention');
    const b = await provider.embed('malaria prevention');
    const c = await provider.embed('prevention malaria');
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('handles empty input without NaN', async () => {
    const v = await provider.embed('!!! ...');
    expect(v.every((x) => Number.isFinite(x))).toBe(true);
  });
});
