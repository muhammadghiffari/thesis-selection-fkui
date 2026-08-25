import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { IsIn, IsUUID } from 'class-validator';
import type { Request, Response } from 'express';
import type { AuthUser } from '../identity/auth-user.js';
import { Roles } from '../identity/decorators/roles.decorator.js';
import { ReportsService } from './reports.service.js';

const KINDS = ['final_selections', 'final_selections_pdf', 'swap_history', 'integrity_summary'] as const;

export class CreateReportDto {
  @IsIn(KINDS) kind!: string;
  @IsUUID() periodId!: string;
}

function requireUser(req: Request): AuthUser {
  const user = req.user as AuthUser | undefined;
  if (!user) throw new BadRequestException('unauthenticated');
  return user;
}

/** Async report exports — admin only, scoped by role at the controller. */
@Roles('admin')
@Controller('reports')
export class ReportsController {
  constructor(@Inject(ReportsService) private readonly reports: ReportsService) {}

  @Post()
  request(@Req() req: Request, @Body() dto: CreateReportDto) {
    const user = requireUser(req);
    return this.reports.request(user, dto.kind, dto.periodId);
  }

  @Get()
  listMine(@Req() req: Request) {
    return this.reports.listMine(requireUser(req));
  }

  /** Authenticated download; owner or admin; ready jobs only. */
  @Get(':id/download')
  async download(
    @Req() req: Request,
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    const user = requireUser(req);
    const { buffer, filename } = await this.reports.download(user, id);
    res.setHeader('content-type',
      filename.endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('content-disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }
}


