import { Module, type OnApplicationBootstrap } from '@nestjs/common';
import { MAGIC_RESEND_PORT } from '../../shared/ports/magic-resend.port.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { AdminSupportController, SupportController } from './support.controller.js';
import { SupportService } from './support.service.js';

@Module({
  imports: [
    // Import NotificationsModule to consume the MAGIC_RESEND_PORT adapter.
    // SupportService depends only on the MAGIC_RESEND_PORT interface (not on
    // NotificationsService directly), satisfying AGENTS.md rule 9.
    NotificationsModule,
  ],
  controllers: [SupportController, AdminSupportController],
  providers: [
    SupportService,
    {
      // Adapter: wire NotificationsService.resend to the MAGIC_RESEND_PORT interface.
      // SupportService injects MAGIC_RESEND_PORT — it never sees NotificationsService.
      provide: MAGIC_RESEND_PORT,
      inject: [NotificationsService],
      useFactory: (notifs: NotificationsService) => ({
        resendForStudent: (studentId: string, periodId: string) =>
          notifs.resend(studentId, periodId),
      }),
    },
  ],
})
export class SupportModule implements OnApplicationBootstrap {
  constructor(private readonly support: SupportService) {}

  /** Seed/refresh rule chunks at startup so RAG is always up to date. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const { upserted } = await this.support.seedChunks();
      console.log(`[SupportModule] ${upserted} rule chunks seeded/refreshed`);
    } catch (err) {
      // Non-fatal — don't block startup if DB isn't ready
      console.warn('[SupportModule] chunk seeding skipped:', err);
    }
  }
}
