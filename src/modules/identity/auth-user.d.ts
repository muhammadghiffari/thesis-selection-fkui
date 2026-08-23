import type { Role } from './decorators/roles.decorator.js';

export interface AuthUser {
  sub: string;
  email: string;
  role: Role;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
