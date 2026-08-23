import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { appConfig } from './shared/config/configuration.js';
import { AppConfigModule } from './shared/config/app-config.module.js';
import { DbModule } from './shared/db/db.module.js';
import { RedisModule } from './shared/redis/redis.module.js';
import { loggingModule } from './shared/logging/logger.module.js';
import { AllExceptionsFilter } from './shared/filters/all-exceptions.filter.js';
import { HealthModule } from './shared/health/health.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';

@Module({
  imports: [
    AppConfigModule,
    loggingModule(appConfig()),
    DbModule,
    RedisModule,
    HealthModule,
    IdentityModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
