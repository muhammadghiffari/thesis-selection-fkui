import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import type { AuthUser, UserProfile } from './auth-user.js';
import type { Role } from './decorators/roles.decorator.js';
import { LoginRateLimiter } from './login-rate-limiter.js';
import { RefreshTokensService } from './refresh-tokens.service.js';
import { StudentEmailService } from './student-email.service.js';
import { UsersService } from './users.service.js';

const ACCESS_TTL = '15m';

/** argon2id hash of a random string; verifies against unknown emails to equalize timing. */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$ZHVtbXlzYWx0ZHVtbXlzYWx0$0W7zUaMOCiWTG9j6nd1ErjEWdPTTKTfKRVhzG3ezFcs';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

function pgCode(err: unknown): string | undefined {
  let cur = err as { code?: string; cause?: unknown };
  while (cur && typeof cur.code !== 'string' && cur.cause !== undefined) {
    cur = cur.cause as typeof cur;
  }
  return cur?.code;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly studentEmails: StudentEmailService,
    private readonly refreshTokens: RefreshTokensService,
    private readonly rateLimiter: LoginRateLimiter,
  ) {}

  /** Email+password login for admin/lecturer; students use magic links (F3). */
  async login(email: string, password: string, ip: string): Promise<TokenPair> {
    await this.rateLimiter.assertAllowed(email, ip);

    const user = await this.users.findStaffForLogin(email);
    const ok = user?.passwordHash
      ? await argon2.verify(user.passwordHash, password)
      : await argon2.verify(DUMMY_HASH, password).catch(() => false);
    if (!user || !ok) {
      await this.rateLimiter.recordFailure(email, ip);
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.rateLimiter.reset(email, ip);
    return this.issueSession(user.id, user.role as Role);
  }

  /** Public self-registration — students only, @ui.ac.id (STUDENT_DOMAINS) enforced. */
  async registerStudent(email: string, password: string): Promise<TokenPair> {
    this.studentEmails.assertValidStudentEmail(email);
    const user = await this.createUserGuarded({ email, password, role: 'student' });
    return this.issueSession(user.id, user.role);
  }

  /** Admin-provisioned staff accounts (lecturers/admins). */
  async createStaff(input: { email: string; password: string; role: 'admin' | 'lecturer' }): Promise<UserProfile> {
    return this.createUserGuarded(input);
  }

  private async createUserGuarded(input: {
    email: string;
    password: string;
    role: Role;
  }): Promise<UserProfile & { role: Role }> {
    try {
      const created = await this.users.createUser(input);
      const profile = await this.users.findById(created.id);
      if (!profile) throw new Error('user vanished right after insert');
      return profile as UserProfile & { role: Role };
    } catch (err) {
      if (pgCode(err) === '23505') throw new ConflictException('Email already registered');
      throw err;
    }
  }

  /** Exchanges a valid refresh token for a fresh pair (rotation invalidates the old one). */
  async refresh(rawRefreshToken: string): Promise<TokenPair> {
    const session = await this.refreshTokens.rotate(rawRefreshToken);
    return this.issueSession(session.userId, session.role);
  }

  async logout(rawRefreshToken: string): Promise<{ success: true }> {
    await this.refreshTokens.revoke(rawRefreshToken);
    return { success: true };
  }

  profile(userId: string): Promise<UserProfile | null> {
    return this.users.findById(userId);
  }

  toAuthUser(profile: UserProfile): AuthUser {
    return { sub: profile.id, role: profile.role };
  }

  private async issueSession(userId: string, role: Role): Promise<TokenPair> {
    const [accessToken, refresh] = await Promise.all([
      this.jwt.signAsync({ sub: userId, role } satisfies AuthUser, { expiresIn: ACCESS_TTL }),
      this.refreshTokens.issue(userId),
    ]);
    return { accessToken, refreshToken: refresh.raw };
  }
}
