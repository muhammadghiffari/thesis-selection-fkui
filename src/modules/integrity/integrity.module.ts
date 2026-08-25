import { Module } from '@nestjs/common';
import { IntegrityAdminController, LecturerController } from './integrity.controller.js';
import { IntegrityService } from './integrity.service.js';

@Module({
  controllers: [IntegrityAdminController, LecturerController],
  providers: [IntegrityService],
})
export class IntegrityModule {}
