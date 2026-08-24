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
