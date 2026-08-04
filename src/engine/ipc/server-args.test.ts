import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServerArgs } from './spawn-server.js';
import { createServerArgsAttachmentDrain, parseIpcServerArgs } from './server-args.js';

const candidate = {
  version: 1 as const,
  sessionId: 'test-session',
  generation: '12345678-1234-4123-8123-123456789abc',
};

describe('createServerArgsAttachmentDrain', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'server-args-drain-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('materializes persisted records into full image attachments and drains once', () => {
    const imgPath = join(tmp, 'mockup.png');
    writeFileSync(imgPath, Buffer.from([1, 2, 3, 4]));

    const drain = createServerArgsAttachmentDrain([
      { id: 'att-1', path: imgPath, mimeType: 'image/png' },
    ]);

    const drained = drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({
      id: 'att-1',
      kind: 'image',
      path: imgPath,
      mimeType: 'image/png',
      sizeBytes: 4,
    });
    expect(drained[0]).not.toHaveProperty('addedAt');
    expect(drain()).toEqual([]);
  });

  it('falls back to a positive size when the file is gone', () => {
    const drain = createServerArgsAttachmentDrain([
      { id: 'att-1', path: join(tmp, 'missing.png'), mimeType: 'image/png' },
    ]);

    const drained = drain();
    expect(drained[0]?.sizeBytes).toBeGreaterThan(0);
  });

  it('returns nothing when no attachments were persisted', () => {
    expect(createServerArgsAttachmentDrain(undefined)()).toEqual([]);
    expect(createServerArgsAttachmentDrain([])()).toEqual([]);
  });
});

describe('parseIpcServerArgs launch contract', () => {
  it('serializes only sanitized bootstrap inputs and the parent candidate', () => {
    const args = buildServerArgs({
      candidate,
      projectDir: '/repo',
      feature: 'feature',
      overrides: {
        mode: 'quick',
        planner: { tool: 'codex' },
        implementer: { model: 'local' },
      },
      allowRepoRunners: true,
    });

    expect(parseIpcServerArgs(JSON.parse(JSON.stringify(args)))).toEqual(args);
    const serialized = JSON.stringify(args);
    expect(serialized).not.toContain('args');
    expect(args).not.toHaveProperty('config');
    expect(args).not.toHaveProperty('gates');
    expect(args).not.toHaveProperty('preparationId');
    expect(args).not.toHaveProperty('configPath');
    expect(args).not.toHaveProperty('diagnostics');
    expect(args.candidate).toEqual(candidate);
  });

  it('rejects server args with incorrectly typed nested overrides', () => {
    const parsed = parseIpcServerArgs({
      version: 1,
      parentPid: process.pid,
      candidate,
      projectDir: '/repo',
      feature: 'feature',
      overrides: { yolo: 'yes' },
    });

    expect(parsed).toBeNull();
  });

  it('rejects raw runner arguments at the persisted transport boundary', () => {
    expect(
      parseIpcServerArgs({
        version: 1,
        parentPid: process.pid,
        candidate,
        projectDir: '/repo',
        feature: 'feature',
        overrides: { planner: { args: ['--header', 'secret'] } },
      }),
    ).toBeNull();
  });

  it('rejects unknown nested override keys', () => {
    const parsed = parseIpcServerArgs({
      version: 1,
      parentPid: process.pid,
      candidate,
      projectDir: '/repo',
      feature: 'feature',
      overrides: { planner: { tool: 'codex', extra: true } },
    });

    expect(parsed).toBeNull();
  });

  it.each([
    'config',
    'gates',
    'preparationId',
    'apiKey',
    'diagnostics',
    'environment',
  ])('rejects transported %s authority', (field) => {
    expect(
      parseIpcServerArgs({
        version: 1,
        parentPid: process.pid,
        candidate,
        projectDir: '/repo',
        feature: 'feature',
        overrides: {},
        [field]: {},
      }),
    ).toBeNull();
  });

  it.each(['full', 'spec-kit'])('rejects the removed %s alias inside overrides', (mode) => {
    expect(
      parseIpcServerArgs({
        version: 1,
        parentPid: process.pid,
        candidate,
        projectDir: '/repo',
        feature: 'feature',
        overrides: { mode },
      }),
    ).toBeNull();
  });
});
