import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import type { Request, Response } from 'express';
import { AuditService } from '../../shared/audit/audit.service.js';
import { assertUploadable, parseSpreadsheet } from '../../shared/parsing/spreadsheet.js';
import type { AuthUser } from '../identity/auth-user.js';
import { Roles } from '../identity/decorators/roles.decorator.js';
import { countValidTheses, validateThesisRows, type ValidatedThesisRow } from './thesis-import.js';
import { ThesesService } from './theses.service.js';

export class ThesisListQueryDto {
  @IsUUID() periodId!: string;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize?: number;
}

export class ThesisCommitDto {
  @IsUUID() periodId!: string;
  /** Rows may carry lecturer_full_name; server resolves/creates lecturers. */
  @ArrayMinSize(1) @IsArray() rows!: Array<{
    title: string;
    track: string;
    description?: string;
    maxClaims?: number;
    lecturerFullName: string;
  }>;
}

function requireUser(req: Request): AuthUser {
  const user = req.user;
  if (!user) throw new BadRequestException('authentication required');
  return user;
}

/**
 * Title secrecy: theses live exclusively behind /api/admin/* (and later the
 * lecturer portal). No student-facing endpoint exposes titles before opens_at.
 */
@Roles('admin')
@Controller('admin/theses')
export class ThesesController {
  constructor(
    @Inject(ThesesService) private readonly theses: ThesesService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  list(@Query() q: ThesisListQueryDto) {
    return this.theses.list(q);
  }

  @Get('export.xlsx')
  async exportXlsx(@Query('periodId') periodId: string, @Res() res: Response): Promise<void> {
    const buffer = await this.theses.exportXlsx(periodId);
    res.setHeader(
      'content-type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('content-disposition', 'attachment; filename="theses.xlsx"');
    res.send(buffer);
  }

  @Post('import/preview')
  @UseInterceptors(FileInterceptor('file'))
  async preview(
    @Query('periodId') _periodId: string,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<{ rows: ValidatedThesisRow[]; total: number; valid: number }> {
    if (!file) throw new BadRequestException('file field is required');
    const ext = assertUploadable(file.originalname, file.size);
    const parsed = await parseSpreadsheet(file.buffer, ext);
    const rows = validateThesisRows(parsed);
    return { rows, total: rows.length, valid: countValidTheses(rows) };
  }

  @Post('import/commit')
  async commit(@Req() req: Request, @Body() dto: ThesisCommitDto) {
    const user = requireUser(req);
    const result = await this.theses.commitImport(dto.periodId, dto.rows);
    await this.audit.log({ id: user.sub, role: user.role }, 'thesis.import_commit', 'thesis', null, {
      periodId: dto.periodId,
      inserted: result.inserted.length,
      skipped: result.skipped.length,
    });
    return result;
  }
}
