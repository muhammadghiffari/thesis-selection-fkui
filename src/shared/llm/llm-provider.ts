/**
 * LLM completion port for F10 support chat.
 * Concrete implementations: StubLlmProvider (dev/test) and GroqLlmProvider (prod).
 * Callers must NEVER receive a 500 — implementations must swallow errors and fall back.
 */
export const LLM_PROVIDER = 'LLM_PROVIDER';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmCompletion {
  content: string;
  /** true when the stub or a fallback path was used instead of the real LLM */
  isFallback: boolean;
}

export interface LlmProvider {
  /**
   * Complete a conversation turn.
   * Must NEVER throw — return isFallback=true with a safe deterministic answer on failure.
   */
  complete(messages: LlmMessage[], contextChunk: string): Promise<LlmCompletion>;
}
