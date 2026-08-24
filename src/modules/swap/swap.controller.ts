import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { IsIn, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import type { AuthUser } from '../identity/auth-user.js';
import { Roles } from '../identity/decorators/roles.decorator.js';
import { SwapService } from './swap.service.js';
import { WatchersService } from './watchers.service.js';

export class CreateSwapDto {
  @IsUUID() selectionId!: string;
  @IsIn(['wrong_pick', 'interest_mismatch', 'lecturer_schedule_issue', 'other']) category!: string;
  @IsString() @MinLength(20) @MaxLength(2000) detail!: string;
  @IsString() @MinLength(8) idempotencyKey!: string;
}

export class DecideDto {
  @IsIn(['approve', 'reject']) decision!: 'approve' | 'reject';
  /** Mandatory — requests without a written note are rejected with 400. */
  @IsString() @MinLength(3) note!: string;
}

export class RevokeDto {
  @IsUUID() selectionId!: string;
  @IsString() @MinLength(3) reason!: string;
}

export class WatchDto {
  @IsUUID() thesisId!: string;
}

function requireUser(req: Request): AuthUser {
  const user = req.user;
  if (!user) throw new Error('unauthenticated');
  return user;
}

@Roles('student')
@Controller('swaps')
export class SwapController {
  constructor(@Inject(SwapService) private readonly swaps: SwapService) {}

  @Post()
  request(@Req() req: Request, @Body() dto: CreateSwapDto) {
    const user = requireUser(req);
    return this.swaps.request(user, dto);
  }

  @Get('mine')
  mine(@Req() req: Request) {
    return this.swaps.listMine(requireUser(req));
  }

  @Post(':id/cancel')
  cancel(@Req() req: Request, @Param('id') id: string) {
    const user = requireUser(req);
    return this.swaps.cancel(user, id);
  }

  /** Old owner re-wars during the grace window. */
  @Post('grace/:selectionId/reclaim')
  reclaim(@Req() req: Request, @Param('selectionId') selectionId: string) {
    const user = requireUser(req);
    return this.swaps.reclaim(user, selectionId);
  }
}

@Roles('lecturer', 'admin')
@Controller('admin/swaps')
export class SwapReviewController {
  constructor(@Inject(SwapService) private readonly swaps: SwapService) {}

  @Get('queue')
  queue(@Req() req: Request) {
    return this.swaps.reviewQueue(requireUser(req));
  }

  /** Approve/reject with MANDATORY note (400 otherwise). Audited. */
  @Patch(':id/decision')
  async decide(@Req() req: Request, @Param('id') id: string, @Body() dto: DecideDto) {
    const user = requireUser(req);
    return this.swaps.decide(user, id, dto.decision, dto.note);
  }
}

@Roles('admin')
@Controller('admin/swaps')
export class SwapAdminController {
  constructor(@Inject(SwapService) private readonly swaps: SwapService) {}

  /** taken --revoke(reason)--> available (+attempts_left++). */
  @Post('revoke')
  revoke(@Req() req: Request, @Body() dto: RevokeDto) {
    const user = requireUser(req);
    return this.swaps.revoke(user, dto.selectionId, dto.reason);
  }
}

@Roles('student')
@Controller('watchers')
export class WatchersController {
  constructor(@Inject(WatchersService) private readonly watchers: WatchersService) {}

  @Post()
  subscribe(@Req() req: Request, @Body() dto: WatchDto) {
    return this.watchers.subscribe(requireUser(req).sub, dto.thesisId);
  }

  @Delete(':thesisId')
  unsubscribe(@Req() req: Request, @Param('thesisId') thesisId: string) {
    return this.watchers.unsubscribe(requireUser(req).sub, thesisId);
  }

  @Get()
  listMine(@Req() req: Request) {
    return this.watchers.listMine(requireUser(req).sub);
  }
}
