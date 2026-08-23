import { IsEmail, IsIn, IsString, MinLength } from 'class-validator';

const PASSWORD_MIN = 8;

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(PASSWORD_MIN)
  password!: string;
}

export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(PASSWORD_MIN)
  password!: string;
}

export class StaffDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(PASSWORD_MIN)
  password!: string;

  /** Students self-register; staff accounts are admin-provisioned only. */
  @IsIn(['admin', 'lecturer'])
  role!: 'admin' | 'lecturer';
}

export class RefreshTokenDto {
  @IsString()
  refreshToken!: string;
}
