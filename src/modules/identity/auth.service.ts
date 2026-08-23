import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import type { AuthUser } from './auth-user.js';
import { UsersService } from './users.service.js';

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
  ) {}

  /** Email+password login for admin/lecturer. Students use magic links (F3). */
  async login(email: string, password: string): Promise<{ accessToken: string; user: AuthUser }> {
    const user = await this.users.findStaffForLogin(email);
    // constant-ish time: always run a verify, even against a dummy hash
    const ok = user?.passwordHash
      ? await argon2.verify(user.passwordHash, password)
      : await argon2.verify(DUMMY_HASH, password).catch(() => false);
    if (!user || !ok) throw new UnauthorizedException('Invalid credentials');

    const payload: AuthUser = {
      sub: user.id,
      email: user.email,
      role: user.role as AuthUser['role'],
    };
    return { accessToken: await this.jwt.signAsync(payload), user: payload };
  }

  async me(user: AuthUser): Promise<AuthUser> {
    return user;
  }
}

/** argon2id hash of a random string; used to equalize timing on unknown emails. */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$ZHVtbXlzYWx0ZHVtbXlzYWx0$0W7zUaMOCiWTG9j6nd1ErjEWdPTTKTfKRVhzG3ezFcs';
