import { describe, it, expect } from 'vitest';
import { createRpcCommandContext } from './command-context.js';
import { createEventBus } from '../../engine/events/bus.js';
import { createDefaultConfig } from '../../core/config/load/load.js';

function makeRpcContext(getConfig: () => ReturnType<typeof createDefaultConfig> | null) {
  return createRpcCommandContext({
    projectDir: '/tmp/proj',
    getSessionId: () => undefined,
    getState: () => null,
    getConfig,
    setConfig: () => {},
    getPhase: () => 'implementing',
    queueHandler: () => null,
    clearQueueHandler: () => null,
    abort: () => {},
    bus: createEventBus(),
    messages: [],
    errors: [],
    pendingQueueDepth: () => 0,
  });
}

describe('createRpcCommandContext', () => {
  it('reports a session-specific error for session-requiring commands without a session', () => {
    const ctx = makeRpcContext(() => createDefaultConfig());
    expect(() => ctx.acceptRunSnapshot()).toThrow(/No active session/);
  });

  it('reports a config-specific error (not the session error) when config is absent', () => {
    const ctx = makeRpcContext(() => null);
    expect(() => ctx.compactTranscript()).toThrow(/No config loaded/);
  });
});
