import { Global, Module } from '@nestjs/common';
import { AlertsService } from './alerts.service.js';

/** Global alert sink (webhook + log fallback) usable from any module. */
@Global()
@Module({
  providers: [AlertsService],
  exports: [AlertsService],
})
export class AlertsModule {}
