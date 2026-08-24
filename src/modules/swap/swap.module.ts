import { Module } from '@nestjs/common';
import {
  SwapAdminController,
  SwapController,
  SwapReviewController,
  WatchersController,
} from './swap.controller.js';
import { SwapService } from './swap.service.js';
import { WatchersService } from './watchers.service.js';

@Module({
  controllers: [SwapController, SwapReviewController, SwapAdminController, WatchersController],
  providers: [SwapService, WatchersService],
})
export class SwapModule {}
