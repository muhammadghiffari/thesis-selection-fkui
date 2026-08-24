import { Module } from '@nestjs/common';
import { WarController } from './war.controller.js';
import { WarService } from './war.service.js';
import { WarRateLimiter } from './rate-limiter.js';

@Module({
  controllers: [WarController],
  providers: [WarService, WarRateLimiter],
  exports: [WarService],
})
export class WarModule {}
