import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServerArgs } from './spawn-server.js';
import { createServerArgsAttachmentDrain, parseIpcServerArgs } from './server-args.js';
import { cliStartGatesFromArray } from '../runners/start-gate.js';
import {
  resolveCliExecutable,
  revalidateCliExecutableIdentity,
} from '../runners/resolve-cli-executable.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

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
  itUnix('preserves a digest-bound executable receipt through detached launch JSON', async () => {
    const projectDir = createTempDir('server-args-receipt-project');
    const executableDir = createTempDir('server-args-receipt-bin');
    const executablePath = join(executableDir, 'codex');
    try {
      writeFileSync(executablePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      chmodSync(executablePath, 0o755);
      const receipt = await resolveCliExecutable(executablePath, projectDir);
      const args = buildServerArgs({
        sessionDir: join(projectDir, '.splitbrief', 'sessions', 'receipt-session'),
        sessionId: 'receipt-session',
        projectDir,
        feature: 'preserve executable receipt',
        mode: 'standard',
        configPath: join(projectDir, '.splitbrief', 'config.yaml'),
        trustedCliGates: cliStartGatesFromArray([{ tool: 'codex', executable: receipt }]),
      });

      const parsed = parseIpcServerArgs(JSON.parse(JSON.stringify(args)));
      expect(parsed).not.toBeNull();
      if (parsed === null) return;
      const gate = parsed.trustedCliGates?.[0];
      expect(gate).toBeDefined();
      if (gate === undefined) return;

      expect(gate.executable).toEqual(receipt);
      expect(await revalidateCliExecutableIdentity(gate.executable)).toBe('match');
    } finally {
      cleanupTempDir(projectDir);
      cleanupTempDir(executableDir);
    }
  });

  it('rejects a malformed digest-bound receipt instead of treating it as legacy metadata', () => {
    const parsed = parseIpcServerArgs({
      sessionId: 'test-session',
      projectDir: '/repo',
      feature: 'feature',
      mode: 'standard',
      configPath: '/repo/.splitbrief/config.yaml',
      overrides: {},
      trustedCliGates: [
        {
          tool: 'codex',
          executable: {
            path: '/usr/local/bin/codex',
            fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
            executableIdentity: {
              canonicalPath: '/usr/local/bin/codex',
              realPath: '/usr/local/bin/codex',
              platformFileId: '1:2',
              fingerprint: '1:2:3:4',
              resolvedAt: 1,
            },
          },
        },
      ],
    });

    expect(parsed).toBeNull();
  });

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

  it.each(['full', 'spec-kit'])('rejects the removed %s mode alias', (mode) => {
    expect(
      parseIpcServerArgs({
        sessionId: 'test-session',
        projectDir: '/repo',
        feature: 'feature',
        mode,
        configPath: '/repo/.splitbrief/config.yaml',
        overrides: {},
      }),
    ).toBeNull();
  });

  it.each(['full', 'spec-kit'])('rejects the removed %s alias inside nested overrides', (mode) => {
    expect(
      parseIpcServerArgs({
        sessionId: 'test-session',
        projectDir: '/repo',
        feature: 'feature',
        mode: 'speckit',
        configPath: '/repo/.splitbrief/config.yaml',
        overrides: { mode },
      }),
    ).toBeNull();
  });
});
