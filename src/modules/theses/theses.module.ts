import { Module } from '@nestjs/common';
import { ThesesController } from './theses.controller.js';
import { ThesesService } from './theses.service.js';

@Module({
  controllers: [ThesesController],
  providers: [ThesesService],
})
export class ThesesModule {}
