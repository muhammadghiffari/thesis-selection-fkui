import { Body, Controller, Get, Inject, Param, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Min, MinLength } from 'class-validator';
import type { Request } from 'express';
import { Roles } from '../identity/decorators/roles.decorator.js';
import { IntegrityService } from './integrity.service.js';

export class QueueQueryDto {
  @IsOptional() @IsIn(['high', 'medium']) level?: 'high' | 'medium';
  @IsOptional() @IsUUID() periodId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize?: number;
}

export class ResolveDto {
  /** false_positive clears the flag; investigate queues follow-up; revoked releases the title. */
  @IsIn(['false_positive', 'investigate', 'revoked']) outcome!: string;
  @IsString() @MinLength(3) note!: string;
}

function requireUser(req: Request): { sub: string; role: 'admin' | 'lecturer' | 'student' } {
  const user = req.user;
  if (!user) throw new UnauthorizedException();
  return user;
}

/** Admin: full integrity queue with signal breakdowns. */
@Roles('admin')
@Controller('admin/integrity')
export class IntegrityAdminController {
  constructor(@Inject(IntegrityService) private readonly integrity: IntegrityService) {}

  @Get()
  queue(@Query() q: QueueQueryDto) {
    return this.integrity.queue({ level: q.level, periodId: q.periodId, page: q.page ?? 1, pageSize: q.pageSize ?? 25 });
  }

  /** Resolve with MANDATORY note; outcome=revoked releases the title (audited). */
  @Post(':flagId/resolve')
  resolve(@Req() req: Request, @Param('flagId') flagId: string, @Body() dto: ResolveDto) {
    const user = requireUser(req);
    return this.integrity.resolve(user, flagId, dto.outcome as 'false_positive' | 'investigate' | 'revoked', dto.note);
  }
}

/** Lecturer dashboard data — OWN theses only, server-enforced scoping. */
@Roles('lecturer')
@Controller('lecturer')
export class LecturerController {
  constructor(@Inject(IntegrityService) private readonly integrity: IntegrityService) {}

  @Get('theses')
  myTheses(@Req() req: Request) {
    return this.integrity.ownTheses(requireUser(req).sub);
  }

  @Get('integrity')
  alerts(@Req() req: Request, @Query() q: QueueQueryDto) {
    return this.integrity.queue({
      level: q.level,
      periodId: q.periodId,
      page: q.page ?? 1,
      pageSize: q.pageSize ?? 25,
      lecturerUserId: requireUser(req).sub,
    });
  }

  /** Resolve alerts on own theses only; scoped + audited. */
  @Post('integrity/:flagId/resolve')
  async resolve(@Req() req: Request, @Param('flagId') flagId: string, @Body() dto: ResolveDto) {
    const user = requireUser(req);
    await this.integrity.assertFlagOwnedByLecturer(flagId, user.sub);
    return this.integrity.resolve(user, flagId, dto.outcome as 'false_positive' | 'investigate' | 'revoked', dto.note);
  }
}
