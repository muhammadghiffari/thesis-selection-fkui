import type { LlmCompletion, LlmMessage, LlmProvider } from './llm-provider.js';
import { StubLlmProvider } from './stub-llm-provider.js';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama3-8b-8192';
const TIMEOUT_MS = 8_000;

interface GroqResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/**
 * Production Groq LLM adapter.
 * Requires GROQ_API_KEY env variable (never hardcoded here).
 * Falls back to StubLlmProvider on any error or timeout — students NEVER see a 500.
 */
export class GroqLlmProvider implements LlmProvider {
  private readonly stub = new StubLlmProvider();

  constructor(private readonly apiKey: string) {}

  async complete(messages: LlmMessage[], contextChunk: string): Promise<LlmCompletion> {
    const systemPrompt =
      `You are a helpful assistant for the FKUI thesis title selection system. ` +
      `Answer the student's question using ONLY the rules excerpt below. ` +
      `NEVER mention, hint at, or reproduce thesis titles. ` +
      `If the answer is not in the excerpt, say you don't know and suggest contacting admin.\n\n` +
      `RULES EXCERPT:\n${contextChunk}`;

    const payload = {
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages.filter((m) => m.role !== 'system'),
      ],
      max_tokens: 512,
      temperature: 0.3,
    };

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const res = await fetch(GROQ_API_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));

      if (!res.ok) {
        console.error(`[GroqLlm] HTTP ${res.status} — falling back to stub`);
        return this.stub.complete(messages, contextChunk);
      }

      const body = (await res.json()) as GroqResponse;
      const text = body.choices?.[0]?.message?.content ?? '';
      if (!text) {
        return this.stub.complete(messages, contextChunk);
      }

      return { content: text, isFallback: false };
    } catch (err) {
      // Timeout or network error — log and fall back gracefully
      const label = err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'error';
      console.error(`[GroqLlm] ${label} — falling back to stub`, err);
      return this.stub.complete(messages, contextChunk);
    }
  }
}
