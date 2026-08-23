import { SetMetadata } from '@nestjs/common';

export type Role = 'admin' | 'lecturer' | 'student';

export const ROLES_KEY = 'roles';
/** Restrict an endpoint to the given roles; omit for "any authenticated user". */
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
