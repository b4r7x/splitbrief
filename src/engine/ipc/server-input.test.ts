import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import type { EngineEvent } from '../events/types.js';
import { createIpcServerTestHarness } from '#testing/helpers/ipc-server.js';

describe('startIpcServer — input', () => {
  let harness: ReturnType<typeof createIpcServerTestHarness>;

  beforeEach(() => {
    harness = createIpcServerTestHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('delivers user_input text when a client sends it', async () => {
    const { srv, onUserInput } = await harness.makeServer();
    const socket = await harness.connectAndAuth(srv.sockPath);

    socket.write(JSON.stringify({ kind: 'user_input', text: 'hello world' }) + '\n');
    await harness.tick();
    await harness.tick();
    expect(onUserInput).toHaveBeenCalledWith('hello world');
  });

  it('reassembles multibyte user_input split across socket frames', async () => {
    const { srv, onUserInput } = await harness.makeServer();
    const socket = await harness.connectAndAuth(srv.sockPath);

    const frame = Buffer.from(
      JSON.stringify({ kind: 'user_input', text: '日本語' }) + '\n',
      'utf8',
    );
    const split = 30;
    socket.write(frame.subarray(0, split));
    await harness.tick();
    socket.write(frame.subarray(split));
    await harness.tick();
    await harness.tick();

    expect(onUserInput).toHaveBeenCalledWith('日本語');
  });

  it('ignores user_input messages without string text', async () => {
    const events: EngineEvent[] = [];
    const { srv, bus, onUserInput } = await harness.makeServer();
    bus.subscribe((e) => events.push(e));
    const socket = await harness.connectAndAuth(srv.sockPath);

    socket.write(
      JSON.stringify({ kind: 'user_input', text: { value: 'secret invalid frame' } }) + '\n',
    );
    await harness.tick();
    await harness.tick();

    expect(onUserInput).not.toHaveBeenCalled();
    expect(
      events.some((e) => e.type === 'warning' && e.message.includes('invalid message structure')),
    ).toBe(true);
    expect(JSON.stringify(events)).not.toContain('secret invalid frame');
  });
});
