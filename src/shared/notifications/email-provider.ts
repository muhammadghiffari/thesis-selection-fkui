export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
  /** Correlation for delivery bookkeeping (notification_deliveries.id). */
  deliveryId?: string;
}

export interface SentReceipt {
  providerId: string;
}

/**
 * Email transport abstraction — Resend in prod, stub everywhere else.
 * Implementations MUST be side-effect-cheap to fake; the source of truth
 * for "was it sent" is notification_deliveries, not the provider.
 */
export interface EmailProvider {
  send(message: EmailMessage): Promise<SentReceipt>;
}

export class StubEmailProvider implements EmailProvider {
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<SentReceipt> {
    this.sent.push(message);
    return { providerId: `stub-${this.sent.length}` };
  }
}

function createResendProvider(key: string): EmailProvider {
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

/**
 * Worker-side transport, no Nest DI: production Resend when RESEND_API_KEY is
 * set, stub otherwise (the normal app path has no stub in production).
 */
export function createEnvEmailProvider(): EmailProvider {
  const key = process.env.RESEND_API_KEY;
  return key ? createResendProvider(key) : new StubEmailProvider();
}
