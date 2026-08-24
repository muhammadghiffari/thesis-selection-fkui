import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { appConfig } from './shared/config/configuration.js';
import { AppConfigModule } from './shared/config/app-config.module.js';
import { AuditModule } from './shared/audit/audit.module.js';
import { DbModule } from './shared/db/db.module.js';
import { RedisModule } from './shared/redis/redis.module.js';
import { loggingModule } from './shared/logging/logger.module.js';
import { AllExceptionsFilter } from './shared/filters/all-exceptions.filter.js';
import { HealthModule } from './shared/health/health.module.js';
import { EventBusModule } from './shared/event-bus/event-bus.module.js';
import { NotificationsInfraModule } from './shared/notifications/notifications-infra.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { EmbeddingsInfraModule } from './shared/embeddings/embeddings-infra.module.js';
import { LobbyModule } from './modules/lobby/lobby.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { StudentsModule } from './modules/students/students.module.js';
import { ThesesModule } from './modules/theses/theses.module.js';
import { PeriodsModule } from './modules/periods/periods.module.js';

@Module({
  imports: [
    AppConfigModule,
    loggingModule(appConfig()),
    AuditModule,
    EventBusModule,
    NotificationsInfraModule,
    EmbeddingsInfraModule,
    DbModule,
    RedisModule,
    HealthModule,
    IdentityModule,
    StudentsModule,
    ThesesModule,
    PeriodsModule,
    NotificationsModule,
    LobbyModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
