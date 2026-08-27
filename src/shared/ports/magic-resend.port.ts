/**
 * Narrow port for magic-link resend (F10 chat → notifications adapter).
 * SupportModule depends ONLY on this interface; NotificationsModule provides
 * the adapter. Follows AGENTS.md rule 9 — no cross-module direct imports.
 */
export const MAGIC_RESEND_PORT = 'MAGIC_RESEND_PORT';

export interface MagicResendPort {
  /**
   * Resends a fresh magic link for the given student+period pair.
   * Delegates to the F3 resend logic already in NotificationsService.
   * Returns the email address the link was sent to.
   */
  resendForStudent(studentId: string, periodId: string): Promise<{ delivered: true }>;
}
