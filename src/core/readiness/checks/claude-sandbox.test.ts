import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { buildClaudeSandboxChecks, isOnSeatPath } from './claude-sandbox.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A project whose `bin` folder holds an executable `bwrap`. */
function projectWithBwrap(): { projectDir: string; bin: string } {
  const projectDir = mkdtempSync(join(tmpdir(), 'splitbrief-claude-sandbox-'));
  roots.push(projectDir);
  const bin = join(projectDir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'bwrap'), '#!/bin/sh\n');
  chmodSync(join(bin, 'bwrap'), 0o755);
  return { projectDir, bin };
}

function claudeImplementerConfig() {
  return makeConfig({
    planner: { kind: 'cli', tool: 'claude-code' },
    implementer: { kind: 'cli', tool: 'claude-code' },
  });
}

function linuxHost(onPath: readonly string[]) {
  return { platform: 'linux' as const, isOnPath: (program: string) => onPath.includes(program) };
}

describe('buildClaudeSandboxChecks', () => {
  it('blocks a claude-code default implementer on Linux and names each missing program', () => {
    const [check] = buildClaudeSandboxChecks(claudeImplementerConfig(), linuxHost([]));

    expect(check).toMatchObject({
      id: 'runners.sandbox.claude-code',
      severity: 'blocker',
      summary: 'Claude Code sandbox cannot start: bwrap and socat are not on PATH.',
      nextAction: 'prepare-runner',
      metadata: { missing: ['bwrap', 'socat'] },
    });
    expect(check?.fix).toContain('apt-get install bubblewrap socat');
    expect(check?.fix).toContain('AppArmor');
  });

  it('names only the program that is missing', () => {
    const [check] = buildClaudeSandboxChecks(claudeImplementerConfig(), linuxHost(['bwrap']));

    expect(check?.summary).toBe('Claude Code sandbox cannot start: socat is not on PATH.');
  });

  it('passes when bwrap and socat are on PATH', () => {
    const [check] = buildClaudeSandboxChecks(
      claudeImplementerConfig(),
      linuxHost(['bwrap', 'socat']),
    );

    expect(check).toMatchObject({ id: 'runners.sandbox.claude-code', severity: 'ok' });
  });

  it('says nothing on macOS, where sandbox-exec is built in', () => {
    expect(
      buildClaudeSandboxChecks(claudeImplementerConfig(), {
        platform: 'darwin',
        isOnPath: () => false,
      }),
    ).toEqual([]);
  });

  it('says nothing when claude-code holds only the planner seat, which runs no sandbox', () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code' },
      implementer: {
        kind: 'api',
        provider: 'ollama',
        model: 'qwen3-coder:30b',
        apiBase: 'http://localhost:11434/v1',
      },
    });

    expect(buildClaudeSandboxChecks(config, linuxHost([]))).toEqual([]);
  });

  it('keeps a non-default claude-code implementer profile advisory', () => {
    const config = makeConfig({
      implementerProfiles: {
        default: 'primary',
        profiles: {
          primary: {
            kind: 'api',
            provider: 'ollama',
            model: 'a',
            apiBase: 'http://localhost:11434/v1',
          },
          spare: { kind: 'cli', tool: 'claude-code' },
        },
      },
    });

    const [check] = buildClaudeSandboxChecks(config, linuxHost([]));

    expect(check?.severity).toBe('warning');
    expect(check).not.toHaveProperty('nextAction');
  });
});

describe('isOnSeatPath', () => {
  it('finds a program on an absolute PATH entry', () => {
    const { projectDir, bin } = projectWithBwrap();

    expect(isOnSeatPath('bwrap', projectDir, ['/nonexistent', bin].join(delimiter))).toBe(true);
  });

  it('never finds a program through a relative or empty PATH entry, which the seat drops', () => {
    const { projectDir } = projectWithBwrap();

    expect(isOnSeatPath('bwrap', projectDir, 'bin')).toBe(false);
    expect(isOnSeatPath('bwrap', join(projectDir, 'bin'), '')).toBe(false);
    expect(isOnSeatPath('bwrap', join(projectDir, 'bin'), ['bin', ''].join(delimiter))).toBe(false);
  });
});
