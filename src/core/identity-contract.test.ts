import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { afterEach, assert, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { ConfigSchema } from './schemas/config.js';
import { SPLITBRIEF_IDENTITY } from './identity.js';
import { SPLITBRIEF_DIR } from './paths.js';
import { readPackageJson } from './project-meta.js';
import { WorkflowModeSchema } from './schemas/enums.js';
import { readActive } from './sessions/active-pointer.js';
import { listSessions } from './sessions/io.js';

const ROOT = join(import.meta.dirname, '..', '..');
const CLI_ENTRY = join(ROOT, 'src', 'cli.ts');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const REQUIRED_COMMANDS = ['start', 'spec', 'init', 'status', 'resume'] as const;
const SUPERSEDED_POSITIONING = [
  'claude',
  'anthropic',
  'openai',
  'gemini',
  'ollama',
  'codex',
  'copilot',
  'cost',
  'cheap',
  'expensive',
  'saving',
  'local model',
] as const;
// Assembled, not written literally: this file is inside the swept tree and a literal
// spelling would make the sweep match its own assertion.
const SUPERSEDED_IDENTITY_PHRASES = [
  ['cost', 'optimized'].join('-'),
  ['plan with', 'claude'].join(' '),
  ['cheap', 'local'].join('/'),
] as const;
const SWEPT_SURFACES = ['src', 'docs', 'package.json', 'README.md', 'CLAUDE.md'] as const;
const SWEPT_EXTENSIONS = new Set(['.ts', '.tsx', '.md', '.json']);

function helpHeader(args: readonly string[]): string {
  const result = spawnSync(TSX, [CLI_ENTRY, ...args], {
    cwd: ROOT,
    timeout: 60_000,
    encoding: 'utf-8',
  });
  expect(result.status).toBe(0);
  const optionsAt = result.stdout.indexOf('\nOptions:');
  assert(optionsAt > 0, `"splitbrief ${args.join(' ')}" printed no Options section`);
  return result.stdout.slice(0, optionsAt).toLowerCase();
}

function readManifest(): Record<string, unknown> {
  const packageManifest = readPackageJson(ROOT, { throwOnInvalid: true });
  assert(packageManifest, 'package.json is missing');
  return packageManifest;
}

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) cleanupTempDir(tempDir);
  tempDir = undefined;
});

describe('SPLITBRIEF identity', () => {
  it('exposes the frozen identity record', () => {
    expect(SPLITBRIEF_IDENTITY).toEqual({
      displayName: 'SPLITBRIEF',
      slug: 'splitbrief',
      executable: 'splitbrief',
      stateDir: '.splitbrief',
      envPrefix: 'SPLITBRIEF_',
      branchPrefix: 'splitbrief/',
    });
  });

  it('names the package after the identity slug', () => {
    const packageManifest = readManifest();
    expect(packageManifest['name']).toBe(SPLITBRIEF_IDENTITY.slug);
    expect(packageManifest['description']).toContain(SPLITBRIEF_IDENTITY.displayName);
  });

  it('maps the bin entry to the identity executable', () => {
    expect(readManifest()['bin']).toEqual({
      [SPLITBRIEF_IDENTITY.executable]: './dist/cli.js',
    });
  });

  it('advertises every required command under the identity usage line', () => {
    const result = spawnSync(TSX, [CLI_ENTRY, '--help'], {
      cwd: ROOT,
      timeout: 60_000,
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: splitbrief');
    expect(result.stdout).toContain('SPLITBRIEF');
    for (const command of REQUIRED_COMMANDS) {
      expect(result.stdout).toMatch(new RegExp(`^  ${command}(?: |$)`, 'm'));
    }
  }, 60_000);

  it('carries no superseded positioning on the help and manifest surfaces', () => {
    const description = readManifest()['description'];
    assert(typeof description === 'string', 'package.json description must be a string');
    expect(
      description.startsWith(SPLITBRIEF_IDENTITY.displayName),
      'package description must lead with the identity display name',
    ).toBe(true);

    const surfaces = [
      ['splitbrief --help', helpHeader(['--help'])],
      ['splitbrief start --help', helpHeader(['start', '--help'])],
      ['package.json description', description.toLowerCase()],
    ] as const;
    for (const [surface, text] of surfaces) {
      for (const term of SUPERSEDED_POSITIONING) {
        expect(text, `${surface} must not carry the superseded framing "${term}"`).not.toContain(
          term,
        );
      }
    }
  }, 60_000);

  it('ignores prior-brand state directories', () => {
    const workingRoot = createTempDir('splitbrief-identity');
    tempDir = workingRoot;
    const projectDir = join(workingRoot, 'prior-only');
    const priorStateDirs = [
      '.diptych', // brand-contract-negative
      '.tiny-spec', // brand-contract-negative
    ] as const;
    mkdirSync(projectDir, { recursive: true });
    for (const stateDir of priorStateDirs) {
      mkdirSync(join(projectDir, stateDir, 'sessions', '2026-03-15-prior'), {
        recursive: true,
      });
      writeFileSync(join(projectDir, stateDir, 'active'), '2026-03-15-prior\n');
    }

    expect(readActive(projectDir)).toBeNull();
    expect(listSessions(projectDir)).toEqual([]);
    for (const stateDir of priorStateDirs) {
      expect(existsSync(join(projectDir, stateDir, 'active'))).toBe(true);
    }
    expect(existsSync(join(projectDir, SPLITBRIEF_DIR))).toBe(false);
  });

  it('accepts config version 3 and rejects superseded versions', () => {
    expect(ConfigSchema.shape.version.safeParse(3).success).toBe(true);
    expect(ConfigSchema.shape.version.safeParse(2).success).toBe(false);
    expect(ConfigSchema.shape.version.safeParse(1).success).toBe(false);
  });

  it('rejects superseded workflow mode names', () => {
    expect(WorkflowModeSchema.safeParse('full').success).toBe(false);
    expect(WorkflowModeSchema.safeParse('spec-kit').success).toBe(false);
  });

  it('no maintained source or doc surface carries a superseded cost-framed phrase', () => {
    const files = SWEPT_SURFACES.flatMap((surface) => {
      const absolute = join(ROOT, surface);
      if (!statSync(absolute).isDirectory()) return [absolute];
      return readdirSync(absolute, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name));
    }).filter((file) => SWEPT_EXTENSIONS.has(extname(file)));

    const offenders = files.flatMap((file) => {
      const text = readFileSync(file, 'utf-8').toLowerCase();
      return SUPERSEDED_IDENTITY_PHRASES.filter((phrase) => text.includes(phrase)).map(
        (phrase) => `${relative(ROOT, file)}: ${phrase}`,
      );
    });

    expect(files.length).toBeGreaterThan(500);
    expect(offenders).toEqual([]);
  });
});
