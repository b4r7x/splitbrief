import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLI_CONFORMANCE_EXIT_CODES } from './contract-harness.js';
import { cwdProbePrompt, runCwdCliConformance } from './contract-harness-cwd.js';

type CwdRecord = {
  verdict: string;
  reason?: string;
  argv: string[];
  shellCwd: string | null;
  landedAt: string[];
};

/**
 * An `opencode` stand-in that does what the probe prompt asks: it runs `pwd`
 * into the named file from its own cwd, or from `scratchDir` when one is given,
 * and replies with the file's absolute path.
 */
async function installTool(toolsDir: string, scratchDir?: string): Promise<void> {
  const path = join(toolsDir, 'opencode');
  const body = [
    '#!/bin/bash',
    'if [[ " $* " == *" --version "* ]]; then echo "opencode v2.0.14"; exit 0; fi',
    'if [[ "$1" != "run" ]]; then exit 1; fi',
    'for arg in "$@"; do prompt=$arg; done',
    'file=$(printf "%s" "$prompt" | grep -oE "hello-[0-9a-f]{8}[.]txt" | head -1)',
    ...(scratchDir === undefined ? [] : [`cd '${scratchDir}'`]),
    'pwd > "$file"',
    'printf \'{"type":"text","part":{"type":"text","text":"%s"}}\\n\' "$(pwd)/$file"',
  ].join('\n');
  await writeFile(path, `${body}\n`, { mode: 0o755 });
  await chmod(path, 0o755);
}

async function scenario() {
  const root = await mkdtemp(join(tmpdir(), 'splitbrief-cwd-harness-'));
  const toolsDir = join(root, 'tools');
  const scratchDir = join(root, 'scratch');
  await mkdir(toolsDir, { recursive: true });
  await mkdir(scratchDir, { recursive: true });
  vi.stubEnv('PATH', `${toolsDir}${delimiter}${process.env.PATH ?? ''}`);
  return {
    toolsDir,
    scratchDir,
    recordPath: join(root, 'cwd.json'),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function readRecord(path: string): Promise<CwdRecord> {
  return JSON.parse(await readFile(path, 'utf8')) as CwdRecord;
}

describe('CLI cwd conformance leg', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('asks for a pwd write without naming a directory to work in', () => {
    const prompt = cwdProbePrompt('hello-0123abcd.txt');
    expect(prompt).toContain('pwd > hello-0123abcd.txt');
    expect(prompt).not.toMatch(/\/[a-z]/i);
  });

  it('passes a tool whose shell runs in the staged project and records the production argv', async () => {
    const fixture = await scenario();
    try {
      await installTool(fixture.toolsDir);
      const outcome = await runCwdCliConformance({
        tool: 'opencode',
        recordPath: fixture.recordPath,
      });
      expect(outcome).toEqual({
        exitCode: CLI_CONFORMANCE_EXIT_CODES.PASS,
        verdict: 'PASS',
        candidateId: 'opencode',
        role: 'implementer',
      });
      const record = await readRecord(fixture.recordPath);
      expect(record.argv).toEqual([
        'run',
        '--standalone',
        '--format',
        'json',
        '--agent',
        'build',
        '<PROMPT>',
      ]);
      expect(record.shellCwd).toBe('<PROJECT_DIR>');
      expect(record.landedAt).toEqual([expect.stringMatching(/^<PROJECT_DIR>\/hello-/)]);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('fails a tool whose shell runs in a scratch directory and removes the stray write', async () => {
    const fixture = await scenario();
    try {
      await installTool(fixture.toolsDir, fixture.scratchDir);
      const outcome = await runCwdCliConformance({
        tool: 'opencode',
        recordPath: fixture.recordPath,
      });
      expect(outcome.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.OMIT);
      expect(outcome.reason).toContain('outside the staged project');
      const record = await readRecord(fixture.recordPath);
      expect(record.verdict).toBe('OMIT');
      expect(record.landedAt).toHaveLength(1);
      expect(record.landedAt[0]).toContain('/scratch/hello-');
      expect(existsSync(record.landedAt[0] ?? '')).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);
});
