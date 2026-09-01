import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  buildServerArgs,
  buildServerArgv,
  resolveEntryPoint,
  type SpawnServerOptions,
} from './server-invocation.js';
import { parseIpcServerArgs, writeIpcServerArgsFile } from './server-args.js';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync('/tmp/sb-invocation-');
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

// The parent's `--otel-exporter` flag lives only in its argv, so the detached host sees it only
// because spawnServer passes `env: buildServerEnv()` to spawn(), and buildServerEnv translates
// readOtelExporterFromArgv(process.argv) into the child's SPLITBRIEF_OTEL_EXPORTER. This probe drives
// the real buildServerEnv() with the flag in argv, boots OTel from the env it produces (the exact
// channel the spawned child inherits), and reports whether that forwarded exporter recorded a span.
function runArgvForwardingProbe(parentExporterFlag: string[]): string {
  const env = { ...process.env };
  delete env['OTEL_TRACES_EXPORTER'];
  delete env['SPLITBRIEF_OTEL_EXPORTER'];

  const script = `
    import { trace } from '@opentelemetry/api';
    import { bootstrapOtel } from './src/lib/otel.ts';
    import { buildServerEnv } from './src/engine/ipc/server-invocation.ts';

    const childEnv = buildServerEnv();

    // The spawned child never inherits the parent's --otel-exporter argv; it sees the exporter only
    // through the env buildServerEnv() forwards. Drop the flag so the env channel is the sole input.
    process.argv = [process.argv[0], process.argv[1]];
    delete process.env.OTEL_TRACES_EXPORTER;
    delete process.env.SPLITBRIEF_OTEL_EXPORTER;
    if (childEnv.SPLITBRIEF_OTEL_EXPORTER !== undefined) {
      process.env.SPLITBRIEF_OTEL_EXPORTER = childEnv.SPLITBRIEF_OTEL_EXPORTER;
    }

    console.dir = (value) => {
      if (value && typeof value === 'object' && value.name === 'forwarded-span') {
        process.stdout.write('exported:forwarded-span');
      }
    };

    bootstrapOtel();
    trace.getTracer('forwarding').startSpan('forwarded-span').end();
  `;

  return execFileSync(
    process.execPath,
    ['--import', 'tsx', '--eval', script, '--', ...parentExporterFlag],
    { cwd: process.cwd(), env, encoding: 'utf-8' },
  );
}

describe('server-invocation otel forwarding', () => {
  it('does not forward an exporter when the parent argv carries no --otel-exporter flag', () => {
    expect(runArgvForwardingProbe([])).toBe('');
  });

  it('forwards the parent --otel-exporter flag so the detached host exports spans', () => {
    expect(runArgvForwardingProbe(['--otel-exporter=console'])).toBe('exported:forwarded-span');
    expect(runArgvForwardingProbe(['--otel-exporter', 'console'])).toBe('exported:forwarded-span');
  });
});

describe('resolveEntryPoint', () => {
  it('runs the tsx src entry under tsx even when a stale dist build exists', () => {
    const root = join(testDir, 'dev-tree');
    const distEntry = join(root, 'dist', 'engine', 'ipc', 'server-entry.js');
    mkdirSync(join(root, 'dist', 'engine', 'ipc'), { recursive: true });
    writeFileSync(distEntry, '// stale compiled build');
    const moduleDir = join(root, 'src', 'engine', 'ipc');
    const moduleFile = join(moduleDir, 'server-invocation.ts');

    const entry = resolveEntryPoint(moduleDir, moduleFile);

    expect(entry.tsx).toBe(true);
    expect(entry.command).toBe('npx');
    expect(entry.args).toEqual(['tsx', join(root, 'src', 'engine', 'ipc', 'server-entry.ts')]);
  });

  it('runs the compiled dist entry for an installed build when dist exists', () => {
    const root = join(testDir, 'installed');
    const distEntry = join(root, 'dist', 'engine', 'ipc', 'server-entry.js');
    mkdirSync(join(root, 'dist', 'engine', 'ipc'), { recursive: true });
    writeFileSync(distEntry, '// compiled build');
    const moduleDir = join(root, 'dist', 'engine', 'ipc');
    const moduleFile = join(moduleDir, 'server-invocation.js');

    const entry = resolveEntryPoint(moduleDir, moduleFile);

    expect(entry.tsx).toBe(false);
    expect(entry.command).toBe(process.execPath);
    expect(entry.args).toEqual([distEntry]);
  });

  it('resolves the real server-entry under tsx when called with no arguments', () => {
    const expectedEntry = join(process.cwd(), 'src', 'engine', 'ipc', 'server-entry.ts');
    const entry = resolveEntryPoint();

    expect(entry.tsx).toBe(true);
    expect(entry.command).toBe('npx');
    expect(entry.args).toEqual(['tsx', expectedEntry]);
    expect(existsSync(expectedEntry)).toBe(true);
  });
});

describe('server args launch contract', () => {
  it('stores detached launch details in a secure args file', () => {
    const argsFile = writeIpcServerArgsFile({
      bootstrapDir: testDir,
      args: {
        version: 1,
        parentPid: process.pid,
        candidate: {
          version: 1,
          sessionId: 'test-session',
          generation: '12345678-1234-4123-8123-123456789abc',
        },
        projectDir: '/repo',
        feature: 'implement from @file\n\nsecret context',
        overrides: { budget: 4 },
      },
    });

    expect(statSync(argsFile).mode & 0o777).toBe(0o600);
    expect(parseIpcServerArgs(JSON.parse(readFileSync(argsFile, 'utf8')))).toMatchObject({
      candidate: { sessionId: 'test-session' },
      feature: 'implement from @file\n\nsecret context',
      overrides: { budget: 4 },
    });

    const argv = buildServerArgv(['server-entry.js'], argsFile);
    expect(argv.join('\n')).not.toContain('implement from @file');
    expect(argv.join('\n')).not.toContain('secret context');
    expect(argv).toEqual(['server-entry.js', argsFile]);
  });
});

describe('buildServerArgs transport policy', () => {
  const base: SpawnServerOptions = {
    candidate: {
      version: 1,
      sessionId: 's',
      generation: '12345678-1234-4123-8123-123456789abc',
    },
    projectDir: '/repo',
    feature: 'add secret oauth login',
  };

  it('keeps the raw feature in the private bootstrap so the detached planner gets the real input', () => {
    const args = buildServerArgs(base);
    expect(args.feature).toBe('add secret oauth login');
  });

  it('forwards repo runner trust to the detached child', () => {
    expect(buildServerArgs({ ...base, allowRepoRunners: true }).allowRepoRunners).toBe(true);
  });

  it.each([
    ['API-key selectors', { planner: { apiKey: 'env:PLANNER_KEY' } }],
    ['raw runner arguments', { implementer: { args: ['--header', 'secret'] } }],
    ['reviewer API-key selectors', { reviewer: { apiKey: 'env:REVIEWER_KEY' } }],
    ['reviewer raw runner arguments', { reviewer: { args: ['--header', 'secret'] } }],
  ])('rejects detached %s instead of silently persisting or dropping them', (_label, overrides) => {
    expect(() => buildServerArgs({ ...base, overrides })).toThrow(/cannot cross/);
  });

  // Failing here names the field; letting the value through fails inside the
  // detached child, where the parent can only report a generic startup failure.
  it.each([
    ['approve', { approve: 'yolo' }, /Invalid approve: yolo/],
    ['plannerEffort', { plannerEffort: 'max' }, /Invalid plannerEffort: max/],
    ['reviewerEffort', { reviewerEffort: 'ludicrous' }, /Invalid reviewerEffort: ludicrous/],
  ])('rejects an out-of-vocabulary %s in the spawning parent', (_label, overrides, message) => {
    expect(() => buildServerArgs({ ...base, overrides })).toThrow(message);
  });

  it.each([
    ['approve', { approve: 'plan' }],
    ['plannerEffort', { plannerEffort: 'high' }],
    ['reviewerEffort', { reviewerEffort: 'low' }],
  ])('carries a valid %s across the boundary', (field, overrides) => {
    expect(buildServerArgs({ ...base, overrides }).overrides).toMatchObject(overrides);
  });
});
