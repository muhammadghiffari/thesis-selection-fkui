import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { DeliveriesController, MagicController } from './notifications.controller.js';
import { MagicTokenService } from './magic-token.service.js';
import { NotificationsService } from './notifications.service.js';

@Module({
  // DI-only import: service code depends on the shared SessionIssuer interface,
  // not on identity classes (AGENTS.md rule 9 — interfaces over imports).
  imports: [IdentityModule],
  controllers: [MagicController, DeliveriesController],
  providers: [NotificationsService, MagicTokenService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
