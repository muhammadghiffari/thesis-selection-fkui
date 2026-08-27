import type { LlmCompletion, LlmMessage, LlmProvider } from './llm-provider.js';

/**
 * Deterministic stub LLM for dev/test.
 * Returns the provided context chunk verbatim rather than calling any external API.
 * This guarantees reproducible test assertions without network calls.
 */
export class StubLlmProvider implements LlmProvider {
  async complete(_messages: LlmMessage[], contextChunk: string): Promise<LlmCompletion> {
    // Echo the matched rule chunk so tests can assert on content
    return {
      content: contextChunk.trim()
        ? `Based on the rules: ${contextChunk.trim()}`
        : "I don't have specific information about that. Please contact admin for help.",
      isFallback: true,
    };
  }
}
