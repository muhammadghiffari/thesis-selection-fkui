import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/configuration.js';
import type { EmailProvider } from './email-provider.js';
import { StubEmailProvider } from './email-provider.js';

export const EMAIL_PROVIDER = 'EMAIL_PROVIDER';

export function createEmailProvider(config: AppConfig): EmailProvider {
  // ponytail: Resend transport lands with the F9 reporting wave; until an
  // API key is configured the stub records sends in-memory only.
  if (config.mailProvider === 'resend' && process.env.RESEND_API_KEY) {
    const key = process.env.RESEND_API_KEY;
    return {
      async send(message) {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            from: process.env.MAIL_FROM ?? 'Thesis Selection <no-reply@fkui.ac.id>',
            to: message.to,
            subject: message.subject,
            html: message.body,
          }),
        });
        if (!res.ok) throw new Error(`resend failed: ${res.status}`);
        const body = (await res.json()) as { id?: string };
        return { providerId: body.id ?? 'unknown' };
      },
    };
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
