import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServerArgsAttachmentDrain, parseIpcServerArgs } from './server-args.js';

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
  it('rejects server args with incorrectly typed nested overrides', () => {
    const parsed = parseIpcServerArgs({
      sessionId: 'test-session',
      projectDir: '/repo',
      feature: 'feature',
      mode: 'standard',
      configPath: '/repo/.splitbrief/config.yaml',
      overrides: { yolo: 'yes' },
    });

    expect(parsed).toBeNull();
  });

  it('strips unknown nested override keys and keeps known fields', () => {
    const parsed = parseIpcServerArgs({
      sessionId: 'test-session',
      projectDir: '/repo',
      feature: 'feature',
      mode: 'standard',
      configPath: '/repo/.splitbrief/config.yaml',
      overrides: { planner: { tool: 'codex', extra: true } },
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.overrides).toEqual({ planner: { tool: 'codex' } });
  });

  it('normalizes the legacy full mode to speckit', () => {
    const parsed = parseIpcServerArgs({
      sessionId: 'test-session',
      projectDir: '/repo',
      feature: 'feature',
      mode: 'full',
      configPath: '/repo/.splitbrief/config.yaml',
      overrides: {},
    });

    expect(parsed?.mode).toBe('speckit');
  });

  it('normalizes the legacy full mode inside nested overrides to speckit', () => {
    const parsed = parseIpcServerArgs({
      sessionId: 'test-session',
      projectDir: '/repo',
      feature: 'feature',
      mode: 'full',
      configPath: '/repo/.splitbrief/config.yaml',
      overrides: { mode: 'full' },
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.mode).toBe('speckit');
    expect(parsed?.overrides.mode).toBe('speckit');
  });
});
