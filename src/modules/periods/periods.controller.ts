import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  IsIn,
} from 'class-validator';
import type { Request } from 'express';
import { AuditService } from '../../shared/audit/audit.service.js';
import type { AuthUser } from '../identity/auth-user.js';
import { Roles } from '../identity/decorators/roles.decorator.js';
import type { PeriodStatus } from './lifecycle.js';
import { PeriodsService } from './periods.service.js';

export class CreatePeriodDto {
  @IsString() @MinLength(3) name!: string;
  @IsString() @MinLength(4) academicYear!: string;
  @IsOptional() @IsISO8601() opensAt?: string;
  @IsOptional() @IsISO8601() closesAt?: string;
}

export class UpdatePeriodDto extends CreatePeriodDto {}

export class TransitionDto {
  @IsIn(['draft', 'scheduled', 'open', 'closed', 'archived']) to!: PeriodStatus;
}

export class SettingsDto {
  @Type(() => Number) @IsInt() @Min(5) @Max(300) lock_duration_sec?: number;
  @Type(() => Number) @IsInt() @Min(0) @Max(120) undo_window_sec?: number;
  @Type(() => Number) @IsInt() @Min(0) @Max(600) grace_period_sec?: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(3) required_selections?: number;
  @Type(() => Number) @IsInt() @Min(1) attempts_default?: number;
  @Type(() => Number) @IsInt() @Min(1) watch_max?: number;
  @IsIn(['first_come', 'lottery'])
  mode?: 'first_come' | 'lottery';
}

function requireUser(req: Request): AuthUser {
  const user = req.user as AuthUser | undefined;
  if (!user) throw new ConflictException('authentication required');
  return user;
}

@Roles('admin')
@Controller('admin/periods')
export class PeriodsController {
  constructor(
    @Inject(PeriodsService) private readonly periods: PeriodsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  list() {
    return this.periods.list();
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    const period = await this.periods.get(id);
    if (!period) throw new NotFoundException('period not found');
    return period;
  }

  @Post()
  async create(@Req() req: Request, @Body() dto: CreatePeriodDto) {
    const user = requireUser(req);
    const created = await this.periods.create(dto);
    await this.audit.log({ id: user.sub, role: user.role }, 'period.create', 'selection_period', created.id, { name: created.name });
    return created;
  }

  /** Config edits allowed in draft only — later phases change via dedicated flows. */
  @Patch(':id')
  async update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdatePeriodDto & SettingsDto) {
    const user = requireUser(req);
    const updated = await this.periods.update(id, dto);
    await this.audit.log({ id: user.sub, role: user.role }, 'period.update', 'selection_period', id, { ...dto });
    return updated;
  }

  /** Soft delete; draft-only. */
  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string) {
    const user = requireUser(req);
    await this.periods.softDelete(id);
    await this.audit.log({ id: user.sub, role: user.role }, 'period.delete', 'selection_period', id, null);
    return { success: true };
  }

  /** Guarded lifecycle move — illegal jumps are 409s. */
  @Post(':id/transition')
  async transition(@Req() req: Request, @Param('id') id: string, @Body() dto: TransitionDto) {
    const user = requireUser(req);
    const updated = await this.periods.transition(id, dto.to);
    await this.audit.log({ id: user.sub, role: user.role }, 'period.transition', 'selection_period', id, {
      to: dto.to,
      status: updated.status,
    });
    return updated;
  }

  /** Deep-copies period CONFIG into a fresh draft; never selections/enrollments. */
  @Post(':id/clone')
  async clone(@Req() req: Request, @Param('id') id: string) {
    const user = requireUser(req);
    const cloned = await this.periods.clone(id);
    await this.audit.log({ id: user.sub, role: user.role }, 'period.clone', 'selection_period', cloned.id, {
      clonedFrom: id,
      name: cloned.name,
    });
    return cloned;
  }
}
