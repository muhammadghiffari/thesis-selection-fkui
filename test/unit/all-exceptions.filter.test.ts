import type { ArgumentsHost } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AllExceptionsFilter } from '../../src/shared/filters/all-exceptions.filter.js';

function fakeHost(url = '/test'): { host: ArgumentsHost; json: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ url }),
    }),
  } as unknown as ArgumentsHost;
  return { host, json, status };
}

const silentLogger = { error: vi.fn() } as never;

describe('AllExceptionsFilter', () => {
  it('maps unknown errors to a 500 body without leaking internals', () => {
    const filter = new AllExceptionsFilter(silentLogger);
    const { host, json, status } = fakeHost('/x');

    filter.catch(new Error('db password is hunter2'), host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 500, message: 'Internal server error', path: '/x' }),
    );
    const body = json.mock.calls[0]![0] as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });

  it('passes HttpException status and message through', () => {
    const filter = new AllExceptionsFilter(silentLogger);
    const { host, json, status } = fakeHost();

    filter.catch(new BadRequestException('Invalid payload'), host);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, message: 'Invalid payload' }),
    );
  });
});
