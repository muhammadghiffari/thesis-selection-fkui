import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ChatMessageDto {
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  content!: string;
}

export class ChatDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(4000)
  message!: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChatMessageDto)
  history?: ChatMessageDto[];
}

export class CheckStatusDto {
  // No required fields — actor resolved from JWT
}

export class CreateTicketDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  @MaxLength(200)
  subject!: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  @MaxLength(5000)
  initialMessage!: string;

  @IsOptional()
  @IsIn(['ai_chat', 'human', 'whatsapp'])
  channel?: 'ai_chat' | 'human' | 'whatsapp';

  @IsOptional()
  @IsObject()
  context?: Record<string, unknown>;
}

export class ResolveTicketDto {
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  note!: string;
}
