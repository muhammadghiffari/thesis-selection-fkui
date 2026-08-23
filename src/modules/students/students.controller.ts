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
import { IsArray, IsIn, IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';
import type { Request, Response } from 'express';
import { AuditService } from '../../shared/audit/audit.service.js';
import { assertUploadable, parseSpreadsheet } from '../../shared/parsing/spreadsheet.js';
import type { AuthUser } from '../identity/auth-user.js';
import { Roles } from '../identity/decorators/roles.decorator.js';
import { countValid, type IncomingStudent, type ValidatedStudentRow } from './student-import.js';
import { StudentsService } from './students.service.js';

export class ListQueryDto {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsIn(['regular', 'kki']) classType?: 'regular' | 'kki' | '';
  @IsOptional() @IsIn(['clinical', 'basic', 'community']) track?: 'clinical' | 'basic' | 'community' | '';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) pageSize?: number;
}

export class CommitImportDto {
  @IsArray() @MinLength(1) rows!: IncomingStudent[];
}

export class BulkActionDto {
  @IsArray() @IsString({ each: true }) @MinLength(1) studentIds!: string[];
  @IsIn(['assign_slots', 'send_magic_links', 'reset_attempts', 'deactivate'])
  action!: 'assign_slots' | 'send_magic_links' | 'reset_attempts' | 'deactivate';
  /** Required for enrollment-scoped actions (assign_slots / reset_attempts / magic links). */
  @IsOptional() @IsString() periodId?: string;
  /** Attempts value for assign_slots / reset_attempts. Defaults to period default (4). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) attempts?: number;
}

function requireUser(req: Request): AuthUser {
  const user = req.user;
  if (!user) throw new BadRequestException('authentication required');
  return user;
}

@Roles('admin')
@Controller('admin/students')
export class StudentsController {
  constructor(
    @Inject(StudentsService) private readonly students: StudentsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  list(@Query() q: ListQueryDto) {
    return this.students.list(q);
  }

  @Get('export.xlsx')
  async exportXlsx(@Query() q: ListQueryDto, @Res() res: Response): Promise<void> {
    const buffer = await this.students.exportXlsx(q);
    res.setHeader(
      'content-type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('content-disposition', 'attachment; filename="students.xlsx"');
    res.send(buffer);
  }

  /** Import stage 1: parse + validate → annotated grid for the UI preview. */
  @Post('import/preview')
  @UseInterceptors(FileInterceptor('file'))
  async preview(
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<{ rows: ValidatedStudentRow[]; total: number; valid: number }> {
    if (!file) throw new BadRequestException('file field is required');
    const ext = assertUploadable(file.originalname, file.size);
    const parsed = await parseSpreadsheet(file.buffer, ext);
    const rows = await this.students.validateAgainstDb(parsed);
    return { rows, total: rows.length, valid: countValid(rows) };
  }

  /**
   * Import stage 2: server re-validates everything (never trusts the client),
   * inserts only currently-valid rows and reports skipped ones.
   */
  @Post('import/commit')
  async commit(@Req() req: Request, @Body() dto: CommitImportDto) {
    const user = requireUser(req);
    const result = await this.students.commitImport(dto.rows);
    await this.audit.log({ id: user.sub, role: user.role }, 'student.import_commit', 'student', null, {
      inserted: result.inserted.length,
      skipped: result.skipped.length,
    });
    return result;
  }

  @Post('bulk')
  async bulk(@Req() req: Request, @Body() dto: BulkActionDto) {
    const user = requireUser(req);
    const result = await this.students.bulkAction(dto);
    await this.audit.log({ id: user.sub, role: user.role }, `student.bulk.${dto.action}`, 'student', null, {
      affected: result.affected,
      periodId: dto.periodId ?? null,
      attempts: dto.attempts ?? null,
    });
    return result;
  }
}
