import { Module } from '@nestjs/common';
import { BroadcastController } from './broadcast.controller.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { RealtimeService } from './realtime.service.js';

@Module({
  controllers: [BroadcastController],
  providers: [RealtimeGateway, RealtimeService],
})
export class RealtimeModule {}
