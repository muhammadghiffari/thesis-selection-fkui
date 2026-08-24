import { Global, Module, type Provider } from '@nestjs/common';
import type { AppConfig } from '../config/configuration.js';
import { ConfigService } from '@nestjs/config';
import { EMBEDDING_DIMENSIONS, EmbeddingProvider, HashingEmbeddingProvider } from './embedding-provider.js';

export const EMBEDDING_PROVIDER = 'EMBEDDING_PROVIDER';

function createEmbeddingProvider(_config: AppConfig | undefined): EmbeddingProvider {
  // ponytail: single implementation today. Local all-MiniLM (transformers.js)
  // plugs in here behind the same interface when F5 needs real semantics.
  void _config;
  return new HashingEmbeddingProvider();
}

const providerToken: Provider = {
  provide: EMBEDDING_PROVIDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => createEmbeddingProvider(config.get<AppConfig>('app')),
};

@Global()
@Module({
  providers: [providerToken],
  exports: [providerToken],
})
export class EmbeddingsInfraModule {}

export { EMBEDDING_DIMENSIONS };
export type { EmbeddingProvider };
