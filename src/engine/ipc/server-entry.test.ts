import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { sessionDir } from '../../core/paths.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import type { IpcServerArgs } from './server-args.js';
import { main } from './server-entry.js';
import type { PreparedExecution } from '../runners/prepared-execution.js';
import type { IpcServer } from './server.js';
import type { StateAuthorityReceipt } from '../../core/state/types.js';

// The detached `start --detach` host runs in a process spawned by spawn-server.ts; main() must call
// bootstrapOtel() first or every span is a NonRecordingSpan (the original F-540 defect). This probe
// invokes the real main() — bootstrapOtel() runs synchronously before main's first await — with the
// exporter on SPLITBRIEF_OTEL_EXPORTER (the env channel spawn-server forwards into), then samples
// whether main()'s bootstrap left a recording provider registered before bailing out of startup.
function runDetachedHostOtelProbe(forwardedExporter: string | undefined): string {
  const env = { ...process.env };
  delete env['OTEL_TRACES_EXPORTER'];
  delete env['SPLITBRIEF_OTEL_EXPORTER'];
  if (forwardedExporter !== undefined) env['SPLITBRIEF_OTEL_EXPORTER'] = forwardedExporter;

  const script = `
    import { mkdtempSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { trace } from '@opentelemetry/api';
    import { main } from './src/engine/ipc/server-entry.ts';

    const projectDir = mkdtempSync(join(tmpdir(), 'server-entry-probe-'));
    const argv = {
      version: 1,
      parentPid: process.pid,
      candidate: {
        version: 1,
        sessionId: 'probe',
        generation: '12345678-1234-4123-8123-123456789abc',
      },
      projectDir,
      feature: 'probe',
      overrides: {},
    };

    // The ConsoleSpanExporter that bootstrapOtel() may register writes spans through console.dir;
    // silence it so this probe's stdout carries only the recording verdict.
    console.dir = () => {};

    // main() is async; bootstrapOtel() is its synchronous first statement, so it runs before the
    // first await returns control here. Sample the provider before the heavy startup proceeds, then
    // exit so the IPC server / workflow loop never starts.
    void main({ argv, bootstrapDir: join(projectDir, 'bootstrap') });
    const span = trace.getTracer('detached-host').startSpan('detached-span');
    process.stdout.write(span.isRecording() ? 'recording' : 'nonrecording');
    span.end();
    process.exit(0);
  `;

  return execFileSync(process.execPath, ['--import', 'tsx', '--eval', script], {
    cwd: process.cwd(),
    env,
    encoding: 'utf-8',
  });
}

describe('detached host OTel bootstrap', () => {
  it('registers a no-op provider when no exporter is forwarded', () => {
    expect(runDetachedHostOtelProbe(undefined)).toBe('nonrecording');
  });

  it('registers a recording provider when main() boots with a forwarded exporter', () => {
    expect(runDetachedHostOtelProbe('console')).toBe('recording');
  });
});

describe('detached preparation handoff', () => {
  it('detached child prepares before publishing final session artifacts', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'server-entry-prepare-'));
    const bootstrapDir = join(projectDir, '.splitbrief', 'bootstrap', 'server-test');
    const candidate = {
      version: 1 as const,
      sessionId: 'detached-prepared',
      generation: '12345678-1234-4123-8123-123456789abc',
    };
    const argv: IpcServerArgs = {
      version: 1,
      parentPid: process.pid,
      candidate,
      projectDir,
      feature: 'prepare first',
      overrides: {},
    };
    const prepared: PreparedExecution = {
      purpose: 'new-workflow',
      config: makeConfig(),
      preparationId: 'prepared-in-child',
      report: {
        generatedAt: '2026-08-04T00:00:00.000Z',
        projectDir,
        status: 'ready',
        counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
        nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready' },
        sections: [],
        metadata: {},
      },
      gates: [],
      session: {
        kind: 'new',
        ref: { projectDir, sessionId: candidate.sessionId },
        ownership: candidate,
        active: candidate,
      },
      runtime: {
        feature: argv.feature,
        allowRepoRunners: false,
        allowHooks: false,
      },
    };
    const authorityReceipt: StateAuthorityReceipt = {
      kind: 'usable',
      sessionId: candidate.sessionId,
      ownerId: 'detached-owner',
      pid: process.pid,
      processStart: '1',
      runId: 'detached-run',
      acquisitionId: 'detached-acquisition',
      fence: 1,
      stateRevision: 1,
      stateDigest: '0'.repeat(64),
    };
    const order: string[] = [];
    const server: IpcServer = {
      sockPath: join(sessionDir(projectDir, candidate.sessionId), 'ipc.sock'),
      requestClientPrompt: async () => {
        throw new Error('not used');
      },
      close: async () => {
        order.push('close');
      },
    };
    mkdirSync(bootstrapDir, { recursive: true });

    try {
      let acceptParent:
        | ((acceptance: {
            version: 1;
            sessionId: string;
            generation: string;
            childPid: number;
          }) => boolean)
        | undefined;
      let handedOff = false;
      const mainPromise = main({
        argv,
        bootstrapDir,
        cleanupProcesses: async () => {},
        dependencies: {
          prepare: async () => {
            order.push('prepare');
            mkdirSync(sessionDir(projectDir, candidate.sessionId), { recursive: true });
            return { kind: 'prepared', execution: prepared };
          },
          acquireAuthority: () => {
            order.push('authority');
            return { kind: 'fenced', receipt: authorityReceipt, promotedFromVersion: null };
          },
          hydrateState: () => {
            order.push('hydrate');
            return { kind: 'missing' };
          },
          assertAuthority: () => {},
          releaseAuthority: () => true,
          startServer: async (options) => {
            order.push('socket');
            acceptParent = options.onParentAccept;
            return server;
          },
          writePreparedResult: ({ result }) => {
            order.push('publish');
            expect(result.ownership).toEqual(candidate);
            expect(result.active).toEqual(candidate);
            return join(bootstrapDir, 'server-result.json');
          },
          runLoop: async (ctx) => {
            order.push('run');
            expect(ctx.prepared).toBe(prepared);
            return makeSummary({ totalTasks: 0 });
          },
          acceptHandoff: () => {
            if (!handedOff) return false;
            order.push('handoff-accepted');
            return true;
          },
          settleHandoff: () => (handedOff ? 'accepted' : 'rolled-back'),
        },
      });

      await vi.waitFor(() =>
        expect(order).toEqual(['prepare', 'authority', 'hydrate', 'socket', 'publish']),
      );
      expect(order).not.toContain('run');
      expect(
        acceptParent?.({
          ...candidate,
          generation: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          childPid: process.pid,
        }),
      ).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(order).not.toContain('run');
      expect(acceptParent?.({ ...candidate, childPid: process.pid })).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(order).not.toContain('run');
      handedOff = true;
      await mainPromise;

      expect(order.slice(0, 5)).toEqual(['prepare', 'authority', 'hydrate', 'socket', 'publish']);
      expect(order).toContain('handoff-accepted');
      expect(order).toContain('run');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
