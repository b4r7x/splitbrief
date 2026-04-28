import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { CONFIG_FILE, DIPTYCH_DIR } from '../../core/paths.js';
import { isCliError } from '../errors.js';
import { registerDoctorCommand } from './doctor.js';

let tmp: string;

beforeEach(() => {
  tmp = createTempDir('doctor-command-test');
});

afterEach(() => {
  cleanupTempDir(tmp);
  vi.restoreAllMocks();
});

function initGitRepo(projectDir: string): void {
  execSync('git init', { cwd: projectDir, stdio: 'pipe' });
}

function writeConfig(projectDir: string, content = validConfigYaml()): string {
  const diptychDir = join(projectDir, DIPTYCH_DIR);
  mkdirSync(diptychDir, { recursive: true });
  const filePath = join(diptychDir, CONFIG_FILE);
  writeFileSync(filePath, content);
  return filePath;
}

function validConfigYaml(): string {
  return [
    'version: 3',
    'planner:',
    '  kind: cli',
    '  tool: claude-code',
    'implementer:',
    '  kind: api',
    '  provider: ollama',
    '  apiBase: http://localhost:11434/v1',
    '  model: qwen2.5-coder:7b',
    '  contextLength: 32768',
    'validation:',
    '  typecheck: true',
    '  lint: false',
    '  test: true',
    '  testCommand: npm test',
    'workflow:',
    '  approve: default',
    '  maxRetries: 3',
    '  persistTranscript: true',
    '  mode: quick',
  ].join('\n');
}

async function runDoctor(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerDoctorCommand(program);
  await program.parseAsync(['node', 'diptych', 'doctor', ...args]);
}

describe('doctor command', () => {
  it('prints human readiness without creating workflow artifacts', async () => {
    initGitRepo(tmp);
    const configFile = writeConfig(tmp);
    const beforeConfig = readFileSync(configFile, 'utf-8');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runDoctor(['--project', tmp]);

    const output = consoleSpy.mock.calls.map(call => call.join(' ')).join('\n');
    expect(output).toContain('Run readiness:');
    expect(output).toContain('Config:');
    expect(output).toContain('Repository:');
    expect(readFileSync(configFile, 'utf-8')).toBe(beforeConfig);
    expect(existsSync(join(tmp, DIPTYCH_DIR, 'active'))).toBe(false);
    expect(existsSync(join(tmp, DIPTYCH_DIR, 'sessions'))).toBe(false);
  });

  it('emits JSON and exits non-zero for missing config without writing setup files', async () => {
    initGitRepo(tmp);
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    let captured: unknown;
    try {
      await runDoctor(['--project', tmp, '--json']);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as { exitCode: number }).exitCode).toBe(1);
    const parsed = JSON.parse(writes.join('').trim()) as { type?: string; report?: { status?: string; nextAction?: { kind?: string } } };
    expect(parsed.type).toBe('readiness_report');
    expect(parsed.report?.status).toBe('blocked');
    expect(parsed.report?.nextAction?.kind).toBe('run-init');
    expect(existsSync(join(tmp, DIPTYCH_DIR))).toBe(false);
  });

  it('reports invalid config as a blocker without rewriting it', async () => {
    initGitRepo(tmp);
    const badConfig = [
      'version: 3',
      'planner:',
      '  kind: cli',
      '  tool: not-a-tool',
      'implementer:',
      '  kind: api',
      '  provider: ollama',
      '  apiBase: http://localhost:11434/v1',
      '  model: qwen2.5-coder:7b',
    ].join('\n');
    const configFile = writeConfig(tmp, badConfig);
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    let captured: unknown;
    try {
      await runDoctor(['--project', tmp, '--json']);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    const parsed = JSON.parse(writes.join('').trim()) as { report?: { status?: string; sections?: Array<{ checks: Array<{ id: string }> }> } };
    expect(parsed.report?.status).toBe('blocked');
    expect(parsed.report?.sections?.flatMap(section => section.checks.map(check => check.id))).toContain('config.invalid');
    expect(readFileSync(configFile, 'utf-8')).toBe(badConfig);
  });

  it('reports a non-git project as blocked', async () => {
    writeConfig(tmp);
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    let captured: unknown;
    try {
      await runDoctor(['--project', tmp, '--json']);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    const parsed = JSON.parse(writes.join('').trim()) as { report?: { sections?: Array<{ checks: Array<{ id: string }> }> } };
    expect(parsed.report?.sections?.flatMap(section => section.checks.map(check => check.id))).toContain('repo.not-git');
  });
});
