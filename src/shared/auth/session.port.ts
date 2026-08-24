/**
 * Narrow port for issuing student sessions without importing the identity
 * module (AGENTS.md rule 9). Wired at the composition root (AppModule).
 */
export const SESSION_ISSUER = Symbol('SESSION_ISSUER');

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
}

export interface SessionIssuer {
  /** Issues a fresh access+refresh pair for an already-authenticated user id. */
  issueSession(
    userId: string,
    role: 'admin' | 'lecturer' | 'student',
  ): Promise<IssuedSession>;
}
