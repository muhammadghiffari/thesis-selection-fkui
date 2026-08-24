export const EMBEDDING_DIMENSIONS = 1536;

/**
 * Text → vector port for AI preference capture and F5 fallback matching.
 * Implementations must return a fixed-dimension float array.
 */
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

/**
 * Deterministic hashing embedder (bag-of-hashed-tokens, L2-normalized).
 * ponytail: semantic quality is placeholder-grade by design — swap with
 * local all-MiniLM via transformers.js or a cheap API by implementing the
 * same interface; pgvector dimension already matches (1536).
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  async embed(text: string): Promise<number[]> {
    const vec = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    const tokens = text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1);
    tokens.forEach((token, position) => {
      const i = hashIndex(token);
      vec[i]! += 1; // positional mixing so word order matters a little
      vec[hashIndex(`${token}#${position}`)]! += 0.5;
    });
    const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  }
}

function hashIndex(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % EMBEDDING_DIMENSIONS;
}
