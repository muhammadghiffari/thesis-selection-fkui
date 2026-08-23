import type { Role } from './decorators/roles.decorator.js';

/** JWT access-token payload — minimal by design ({sub, role}). */
export interface AuthUser {
  sub: string;
  role: Role;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export interface UserProfile {
  id: string;
  email: string;
  role: Role;
  createdAt: Date;
}
