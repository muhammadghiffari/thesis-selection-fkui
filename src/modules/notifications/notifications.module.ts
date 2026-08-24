import { Module } from '@nestjs/common';
import { DeliveriesController, MagicController } from './notifications.controller.js';
import { MagicTokenService } from './magic-token.service.js';
import { NotificationsService } from './notifications.service.js';

@Module({
  controllers: [MagicController, DeliveriesController],
  providers: [NotificationsService, MagicTokenService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
