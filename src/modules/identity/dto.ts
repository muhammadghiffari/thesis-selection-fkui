import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsString, MaxLength, MinLength } from 'class-validator';

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

/** Lowercase + trim so `Admin@X` and `admin@x` map to one account (also avoids email-enumeration variance). */
const lowerEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class LoginDto {
  @Transform(lowerEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(PASSWORD_MIN)
  @MaxLength(PASSWORD_MAX)
  password!: string;
}

export class StaffDto {
  @Transform(lowerEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(PASSWORD_MIN)
  @MaxLength(PASSWORD_MAX)
  password!: string;

  /** Staff accounts are admin-provisioned only. */
  @IsIn(['admin', 'lecturer'])
  role!: 'admin' | 'lecturer';
}

export class RefreshTokenDto {
  @IsString()
  @MinLength(20)
  @MaxLength(512)
  refreshToken!: string;
}

export class ForgotPasswordDto {
  @Transform(lowerEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class ResetPasswordDto {
  @IsString()
  @MinLength(20)
  @MaxLength(512)
  token!: string;

  @IsString()
  @MinLength(PASSWORD_MIN)
  @MaxLength(PASSWORD_MAX)
  password!: string;
}
