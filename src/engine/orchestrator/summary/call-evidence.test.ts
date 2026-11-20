import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SESSION_LOG_FILE, sessionDir } from '../../../core/paths.js';
import { InvocationIdentitySchema } from '../../../core/schemas/invocation-identity.js';
import { createJsonlSink } from '../../events/sinks/jsonl.js';
import type { EngineEvent } from '../../events/types.js';
import { createCallEvidenceSink, resolveCallIdentities } from './call-evidence.js';

const CAPTURED_AT = Date.UTC(2026, 8, 16, 12, 0, 0);

const SEAT_TOOL = 'custom-worker-api';
const SEAT_MODEL = 'deepseek-v4-flash';

const ENFORCED_API_KEY = InvocationIdentitySchema.parse({
  version: 1,
  capturedAt: CAPTURED_AT,
  runner: { kind: 'api', id: SEAT_TOOL },
  configuredChannel: 'api-key',
  enforcedChannel: { channel: 'api-key', evidenceId: 'api.custom-worker.api-key' },
});

function callEvents(callId: string): EngineEvent[] {
  const context = {
    callId,
    role: 'implementer',
    backendKind: 'api',
    runnerName: SEAT_TOOL,
    model: SEAT_MODEL,
    invocationIdentity: ENFORCED_API_KEY,
  } as const;
  return [
    {
      type: 'runner_call_started',
      ts: CAPTURED_AT,
      phase: 'implementing',
      sequence: 1,
      ...context,
    },
    {
      type: 'runner_call_completed',
      ts: CAPTURED_AT + 1000,
      phase: 'implementing',
      sequence: 2,
      status: 'completed',
      error: null,
      partial: false,
      startedAt: CAPTURED_AT,
      endedAt: CAPTURED_AT + 1000,
      durationMs: 1000,
      nativeSessionId: null,
      ...context,
    },
  ];
}

const dirs: string[] = [];

function makeSession(): { projectDir: string; sessionId: string } {
  const projectDir = mkdtempSync(join(tmpdir(), 'splitbrief-call-evidence-'));
  dirs.push(projectDir);
  return { projectDir, sessionId: 'sess-1' };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('run call evidence', () => {
  it('reads the identity of a logged call', () => {
    const ref = makeSession();
    mkdirSync(sessionDir(ref.projectDir, ref.sessionId), { recursive: true });
    const log = createJsonlSink(ref);
    for (const event of callEvents('impl-1')) log(event);

    expect(resolveCallIdentities(ref)).toEqual([
      {
        callId: 'impl-1',
        phase: 'implementing',
        role: 'implementer',
        backendKind: 'api',
        runnerName: SEAT_TOOL,
        model: SEAT_MODEL,
        invocationIdentity: ENFORCED_API_KEY,
      },
    ]);
  });

  it('reads the calls a live run holds, before anything reaches the log', () => {
    const ref = makeSession();
    const sink = createCallEvidenceSink(ref);
    for (const event of callEvents('impl-1')) sink(event);

    expect(existsSync(join(sessionDir(ref.projectDir, ref.sessionId), SESSION_LOG_FILE))).toBe(
      false,
    );
    expect(resolveCallIdentities(ref)?.[0]?.invocationIdentity).toEqual(ENFORCED_API_KEY);
  });

  it('keeps the calls an earlier process logged when a resumed run adds its own', () => {
    const ref = makeSession();
    mkdirSync(sessionDir(ref.projectDir, ref.sessionId), { recursive: true });
    const log = createJsonlSink(ref);
    for (const event of callEvents('impl-1')) log(event);

    const sink = createCallEvidenceSink(ref);
    for (const event of callEvents('impl-2')) sink(event);

    expect(resolveCallIdentities(ref)?.map((item) => item.callId)).toEqual(['impl-1', 'impl-2']);
  });
});
