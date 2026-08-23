import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { eq, and, inArray, isNull } from 'drizzle-orm';
import { Inject } from '@nestjs/common';
import { DATABASE, type Database } from '../../shared/db/db.module.js';
import { users } from '../../shared/db/schema.js';
import type { Role } from './decorators/roles.decorator.js';

const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

@Injectable()
export class UsersService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async hashPassword(plain: string): Promise<string> {
    return argon2.hash(plain, ARGON2_OPTIONS);
  }

  async createUser(input: {
    email: string;
    role: Role;
    password?: string;
  }): Promise<{ id: string; email: string; role: Role }> {
    const passwordHash = input.password ? await this.hashPassword(input.password) : null;
    const [row] = await this.db
      .insert(users)
      .values({ email: input.email.toLowerCase(), role: input.role, passwordHash })
      .returning({ id: users.id, email: users.email, role: users.role });
    if (!row) throw new Error('user insert returned no row');
    return { id: row.id, email: row.email, role: input.role };
  }

  /** Admin/lecturer credential lookup for password login. */
  async findStaffForLogin(email: string) {
    const [row] = await this.db
      .select()
      .from(users)
      .where(
        and(
          eq(users.email, email.toLowerCase()),
          isNull(users.deletedAt),
          inArray(users.role, ['admin', 'lecturer']),
        ),
      )
      .limit(1);
    return row ?? null;
  }
}
