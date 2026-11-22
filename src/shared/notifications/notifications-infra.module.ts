import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/configuration.js';
import { createEnvEmailProvider, StubEmailProvider, type EmailProvider } from './email-provider.js';

export const EMAIL_PROVIDER = 'EMAIL_PROVIDER';

export function createEmailProvider(config: AppConfig): EmailProvider {
  // ponytail: Resend transport via createEnvEmailProvider; until an API key
  // is configured the stub records sends in-memory only.
  if (config.mailProvider === 'resend' && process.env.RESEND_API_KEY) {
    return createEnvEmailProvider();
  }
  return new StubEmailProvider();
}

const providerToken: Provider = {
  provide: EMAIL_PROVIDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => createEmailProvider(config.get<AppConfig>('app')!),
};

/** Global infra for any module that sends mail (notifications today, F9 export later). */
@Global()
@Module({
  providers: [providerToken],
  exports: [providerToken],
})
export class NotificationsInfraModule {}
