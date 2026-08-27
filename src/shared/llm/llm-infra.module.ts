import { Global, Module, type Provider } from '@nestjs/common';
import { LLM_PROVIDER } from './llm-provider.js';
import { StubLlmProvider } from './stub-llm-provider.js';
import { GroqLlmProvider } from './groq-llm-provider.js';

const llmProvider: Provider = {
  provide: LLM_PROVIDER,
  useFactory: () => {
    const apiKey = process.env.GROQ_API_KEY;
    if (apiKey) {
      return new GroqLlmProvider(apiKey);
    }
    // Dev/test: no API key → use stub deterministically
    return new StubLlmProvider();
  },
};

@Global()
@Module({
  providers: [llmProvider],
  exports: [llmProvider],
})
export class LlmInfraModule {}
