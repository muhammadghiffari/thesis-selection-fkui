import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, IsString, Min } from 'class-validator';
import type { Request } from 'express';
import { Roles } from '../../modules/identity/decorators/roles.decorator.js';
import { AuditService } from './audit.service.js';

export class AuditQueryDto {
  @IsOptional() @IsString() actorId?: string;
  @IsOptional() @IsString() action?: string;
  @IsOptional() @IsString() entityType?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize?: number;
  /** ISO date (UTC) lower bound on created_at */
  @IsOptional() @IsISO8601() from?: string;
}

/** Read-only audit trail viewer (admin). Append-only — no mutations here. */
@Roles('admin')
@Controller('admin/audit')
export class AuditController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  @Get()
  list(@Req() req: Request, @Query() q: AuditQueryDto) {
    void req;
    return this.audit.list({
      actorId: q.actorId,
      action: q.action,
      entityType: q.entityType,
      from: q.from,
      page: q.page ?? 1,
      pageSize: Math.min(q.pageSize ?? 25, 100),
    });
  }
}
