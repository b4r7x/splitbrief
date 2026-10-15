import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { chmodSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeConfigYaml } from '#testing/helpers/config-io.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  LOCKFILE,
  sessionDir,
  STATE_FILE,
  SPLITBRIEF_DIR,
  CONFIG_FILE,
  TREES_DIR,
} from '../paths.js';
import { createInitialState } from '../state/machine.js';
import { writeActive } from '../sessions/active-pointer.js';
import { HEARTBEAT_STALENESS_MS } from '../sessions/lockfile-status.js';
import { makeSessionLockfile } from '#testing/helpers/factories/session-lockfile.js';
import { applyRunnerPreparationChecks, collectReadiness } from './collect.js';
import { initConfig } from '../config/load/io.js';
import { createDefaultConfig } from '../config/load/defaults.js';
import { configPath } from '../config/load/document.js';
import { flattenReadinessChecks } from './status.js';

vi.mock('../../lib/git/files.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/git/files.js')>()),
  checkIgnoredPaths: async () => [],
}));

// Stands in for the git binary so repository posture is read from a scripted
// repository instead of a fixture that writes commits. `commands` records every
// git invocation readiness makes.
const scriptedGit = vi.hoisted<{
  repo: { isRepo: boolean; branch: string } | undefined;
  commands: string[][];
  files: { path: string }[];
  notAdded: string[];
  headFiles: Record<string, string>;
}>(() => ({
  repo: undefined,
  commands: [],
  files: [],
  notAdded: [],
  headFiles: {},
}));

vi.mock('../../lib/git/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/git/client.js')>();
  return {
    ...actual,
    getGitForDir: (dir: string) => {
      const repo = scriptedGit.repo ?? { isRepo: false, branch: 'main' };
      const record = (args: string[]) => scriptedGit.commands.push(args);
      return {
        checkIsRepo: async () => {
          record(['rev-parse', '--is-inside-work-tree']);
          return repo.isRepo;
        },
        revparse: async (args: string[]) => {
          record(['rev-parse', ...args]);
          return join(dir, '.git');
        },
        status: async () => {
          record(['status']);
          return { files: scriptedGit.files, not_added: scriptedGit.notAdded };
        },
        showBuffer: async ([spec]: string[]) => {
          record(['show', spec ?? '']);
          const file = scriptedGit.headFiles[(spec ?? '').replace(/^HEAD:/, '')];
          if (file === undefined) throw new Error(`fatal: path '${spec}' does not exist in HEAD`);
          return Buffer.from(file);
        },
        raw: async (args: string[]) => {
          record(args);
          if (args.includes('--verify')) return `${'a'.repeat(40)}\n`;
          if (args.includes('--abbrev-ref')) return `${repo.branch}\n`;
          throw new Error(`fatal: no scripted answer for git ${args.join(' ')}`);
        },
      };
    },
  };
});

beforeEach(() => {
  scriptedGit.repo = undefined;
  scriptedGit.commands = [];
  scriptedGit.files = [];
  scriptedGit.notAdded = [];
  scriptedGit.headFiles = {};
});

function writeSessionState(projectDir: string, sessionId: string, phase: string): void {
  const sDir = sessionDir(projectDir, sessionId);
  mkdirSync(sDir, { recursive: true });
  const state = { ...createInitialState('feature'), phase };
  writeFileSync(join(sDir, STATE_FILE), JSON.stringify(state));
}

function writeSessionLockfile(
  projectDir: string,
  sessionId: string,
  overrides: Parameters<typeof makeSessionLockfile>[1] = {},
): void {
  const sDir = sessionDir(projectDir, sessionId);
  mkdirSync(sDir, { recursive: true });
  writeFileSync(join(sDir, LOCKFILE), JSON.stringify(makeSessionLockfile(sessionId, overrides)));
}

describe('collectReadiness End-of-run checks', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('collect-end-checks');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('names End-of-run checks off as a warning', async () => {
    const { report } = await collectReadiness({
      projectDir: tempDir,
      config: makeConfig({ validation: { endChecks: false } }),
    });

    const checks = flattenReadinessChecks(report.sections);
    expect(checks.find((check) => check.id === 'validation.configured')?.summary).toBe(
      'End-of-run checks: off.',
    );
    expect(checks.find((check) => check.id === 'validation.end-checks-off')?.severity).toBe(
      'warning',
    );
  });
});

describe('collectReadiness runner availability wiring', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('collect-availability');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('uses catalog names throughout the collected runner report', async () => {
    const runner = { kind: 'cli', tool: 'codex', model: 'gpt-6-luna' } as const;
    const { report } = await collectReadiness({
      projectDir: tempDir,
      config: makeConfig({ planner: runner, implementer: runner, reviewer: runner }),
      seatDisplayName: () => 'GPT-6-Luna',
    });
    const summaries = flattenReadinessChecks(report.sections).map((check) => check.summary);
    expect(summaries).toContain('PLAN OpenAI Codex CLI · GPT-6-Luna configured.');
    expect(summaries).toContain('BUILD OpenAI Codex CLI · GPT-6-Luna configured.');
    expect(summaries.join('\n')).not.toContain('GPT-6 Luna');
  });

  it('turns an unreachable default implementer into a blocker', async () => {
    const { report } = await collectReadiness({
      projectDir: tempDir,
      config: makeConfig(),
      probeRunnerAvailability: async () => [
        {
          slot: { role: 'implementer', profile: 'default' },
          provider: 'ollama',
          endpoint: 'http://localhost:11434/v1',
          verdict: { state: 'unavailable', diagnostic: 'fetch failed' },
        },
      ],
    });

    const checks = flattenReadinessChecks(report.sections);
    expect(
      checks.find((check) => check.id === 'runners.availability.implementer.default'),
    ).toMatchObject({ severity: 'blocker' });
    expect(checks.find((check) => check.id === 'runners.availability')).toBeUndefined();
    expect(report.status).toBe('blocked');
  });

  it('falls back to the no-claim notice when the probe itself fails', async () => {
    const { report } = await collectReadiness({
      projectDir: tempDir,
      config: makeConfig(),
      probeRunnerAvailability: async () => {
        throw new Error('probe exploded');
      },
    });

    const checks = flattenReadinessChecks(report.sections);
    expect(checks.find((check) => check.id === 'runners.availability')).toMatchObject({
      severity: 'info',
      summary: 'Provider availability was not probed.',
    });
  });

  it('merges headless admission checks when interaction and probeRunnerAdmission are provided', async () => {
    const { report } = await collectReadiness({
      projectDir: tempDir,
      config: makeConfig(),
      interaction: 'headless',
      probeRunnerAdmission: async () => [
        {
          id: 'runners.preparation.planner',
          severity: 'blocker',
          summary: 'Planner could not be admitted.',
          fix: 'Pass --allow-unverified-auth to start anyway.',
        },
      ],
    });

    const checks = flattenReadinessChecks(report.sections);
    expect(checks).toContainEqual(
      expect.objectContaining({
        id: 'runners.preparation.planner',
        severity: 'blocker',
        fix: 'Pass --allow-unverified-auth to start anyway.',
      }),
    );
  });
});

describe('collectReadiness Claude Code sandbox on Linux', () => {
  let tempDir: string;
  const originalPlatform = process.platform;
  const originalPath = process.env['PATH'];

  beforeEach(() => {
    tempDir = createTempDir('collect-sandbox');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    process.env['PATH'] = tempDir;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    process.env['PATH'] = originalPath;
    cleanupTempDir(tempDir);
  });

  const claudeImplementer = () =>
    makeConfig({
      planner: { kind: 'cli', tool: 'claude-code' },
      implementer: { kind: 'cli', tool: 'claude-code' },
    });

  const sandboxCheck = (report: Awaited<ReturnType<typeof collectReadiness>>['report']) =>
    flattenReadinessChecks(report.sections).find(
      (check) => check.id === 'runners.sandbox.claude-code',
    );

  it('blocks a run that calls the claude-code implementer without bwrap and socat', async () => {
    const { report } = await collectReadiness({
      projectDir: tempDir,
      config: claudeImplementer(),
      roles: ['planner', 'implementer', 'reviewer'],
    });

    expect(sandboxCheck(report)).toMatchObject({ severity: 'blocker' });
  });

  it.each([[['planner']], [['reviewer']]] as const)(
    'skips the check for a run that calls only %j',
    async (roles) => {
      const { report } = await collectReadiness({
        projectDir: tempDir,
        config: claudeImplementer(),
        roles,
      });

      expect(sandboxCheck(report)).toBeUndefined();
    },
  );
});

describe('preparation readiness projection', () => {
  it('replaces tool-level CLI placeholders with exact slot checks', async () => {
    const projectDir = createTempDir('collect-preparation-checks');
    try {
      const { report } = await collectReadiness({ projectDir, config: makeConfig() });
      const prepared = applyRunnerPreparationChecks(report, [
        {
          id: 'runners.preparation.planner',
          severity: 'ok',
          summary: 'Configured planner is freshly admitted.',
        },
      ]);
      const checks = flattenReadinessChecks(prepared.sections);

      expect(checks.some((check) => check.id.startsWith('runners.cli.'))).toBe(false);
      expect(checks).toContainEqual(
        expect.objectContaining({ id: 'runners.preparation.planner', severity: 'ok' }),
      );
      expect(prepared.counts.blocker).toBe(report.counts.blocker - 1);
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});

describe('collectReadiness git posture', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('collect-git-posture');
    scriptedGit.repo = { isRepo: true, branch: 'main' };
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  function monorepoConfig(workflow?: { isolation: 'none' | 'worktree' }) {
    return makeConfig({
      planner: {
        kind: 'api',
        provider: 'ollama',
        apiBase: 'http://localhost:11434/v1',
        model: 'planner',
        contextLength: 65536,
      },
      validation: { testCommand: 'node -e "process.exit(0)"' },
      ...(workflow !== undefined && { workflow }),
    });
  }

  it('blocks a workspace monorepo with workflow.isolation unset and recommends the checkout', async () => {
    const config = monorepoConfig();
    writeConfigYaml(tempDir, config);
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ name: 'mono' }));
    const { report: baseline } = await collectReadiness({ projectDir: tempDir, config });
    expect(baseline.counts.warning).toBe(0);
    expect(baseline.counts.blocker).toBe(0);
    expect(baseline.status).toBe('ready');
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'mono', workspaces: ['packages/*'] }),
    );

    const { report } = await collectReadiness({ projectDir: tempDir, config });

    const repo = report.sections.find((section) => section.id === 'repo');
    const check = repo?.checks.find((c) => c.id === 'isolation.workspace-links');
    expect(check?.severity).toBe('blocker');
    expect(check?.fix).toContain('`workflow.isolation: none`');
    expect(report.counts).toEqual({ ...baseline.counts, blocker: 1 });
    expect(report.status).toBe('blocked');
    expect(report.nextAction.kind).toBe('fix-config');
  });

  it('recommends the checkout for a monorepo freshly set up with splitbrief init', async () => {
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'mono', workspaces: ['packages/*'] }),
    );
    await initConfig(tempDir, createDefaultConfig());

    expect(readFileSync(configPath(tempDir), 'utf8')).not.toContain('isolation');
    const { report } = await collectReadiness({ projectDir: tempDir });

    const check = report.sections
      .find((section) => section.id === 'repo')
      ?.checks.find((c) => c.id === 'isolation.workspace-links');
    expect(check?.severity).toBe('blocker');
    expect(check?.fix).toContain('`workflow.isolation: none`');
  });

  it('reads workflow.isolation from the config file on disk when no config is passed', async () => {
    writeConfigYaml(tempDir, { workflow: { isolation: 'none' } });
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'mono', workspaces: ['packages/*'] }),
    );

    const { report } = await collectReadiness({ projectDir: tempDir });

    const ids = flattenReadinessChecks(report.sections).map((check) => check.id);
    expect(ids).not.toContain('isolation.workspace-links');
  });

  it('emits no isolation check for a workspace monorepo that set workflow.isolation: none', async () => {
    const config = monorepoConfig({ isolation: 'none' });
    writeConfigYaml(tempDir, config);
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'mono', workspaces: ['packages/*'] }),
    );

    const { report } = await collectReadiness({ projectDir: tempDir, config });

    const ids = flattenReadinessChecks(report.sections).map((check) => check.id);
    expect(ids).not.toContain('isolation.workspace-links');
    expect(report.status).toBe('ready');
  });

  it('keeps the workspace-links warning when workflow.isolation: worktree is explicit', async () => {
    const config = monorepoConfig({ isolation: 'worktree' });
    writeConfigYaml(tempDir, config);
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'mono', workspaces: ['packages/*'] }),
    );

    const { report } = await collectReadiness({ projectDir: tempDir, config });

    const repo = report.sections.find((section) => section.id === 'repo');
    const check = repo?.checks.find((c) => c.id === 'isolation.workspace-links');
    expect(check?.severity).toBe('warning');
    expect(report.status).toBe('ready-with-warnings');
    expect(report.nextAction).toEqual({
      kind: 'continue',
      label: 'Continue',
      reason: 'Only warnings were found.',
    });
  });

  it('reports a failed isolation check when pnpm workspace YAML is invalid', async () => {
    writeFileSync(join(tempDir, 'pnpm-workspace.yaml'), 'packages: [\n');

    const { report } = await collectReadiness({ projectDir: tempDir });

    const repo = report.sections.find((section) => section.id === 'repo');
    const failure = repo?.checks.find((check) => check.id === 'isolation.check-failed');
    expect(failure).toMatchObject({ severity: 'warning' });
    expect(failure?.details?.join('\n')).toContain('line 2');
  });

  it('reports a failed isolation check when the pnpm workspace file cannot be read', async () => {
    mkdirSync(join(tempDir, 'pnpm-workspace.yaml'));

    const { report } = await collectReadiness({ projectDir: tempDir });

    const repo = report.sections.find((section) => section.id === 'repo');
    const failure = repo?.checks.find((check) => check.id === 'isolation.check-failed');
    expect(failure).toMatchObject({ severity: 'warning' });
    expect(failure?.details?.join('\n')).toContain('EISDIR');
  });

  it('warns when the repository is on a detached HEAD', async () => {
    scriptedGit.repo = { isRepo: true, branch: 'HEAD' };

    const { report } = await collectReadiness({ projectDir: tempDir });

    const detached = flattenReadinessChecks(report.sections).find(
      (check) => check.id === 'repo.detached-head',
    );
    expect(detached?.severity).toBe('warning');
  });

  it('does not warn about a detached HEAD when on a branch', async () => {
    const { report } = await collectReadiness({ projectDir: tempDir });

    expect(
      flattenReadinessChecks(report.sections).find((check) => check.id === 'repo.detached-head'),
    ).toBeUndefined();
  });

  it('blocks when a merge is in progress', async () => {
    mkdirSync(join(tempDir, '.git'));
    writeFileSync(join(tempDir, '.git', 'MERGE_HEAD'), 'a'.repeat(40));

    const { report } = await collectReadiness({ projectDir: tempDir });

    const inProgress = flattenReadinessChecks(report.sections).find(
      (check) => check.id === 'repo.in-progress-git-op',
    );
    expect(inProgress?.severity).toBe('blocker');
    expect(report.status).toBe('blocked');
  });

  it('counts only the operator edits in the dirty worktree, not the isolation worktree or state dir', async () => {
    mkdirSync(join(tempDir, 'src'));
    writeFileSync(join(tempDir, 'src', 'edited.ts'), 'export const a = 2;\n');
    mkdirSync(join(tempDir, TREES_DIR, 'sess-1', 'src'), { recursive: true });
    writeFileSync(join(tempDir, TREES_DIR, 'sess-1', 'src', 'edited.ts'), 'export const a = 3;\n');
    mkdirSync(join(tempDir, SPLITBRIEF_DIR), { recursive: true });
    writeFileSync(join(tempDir, SPLITBRIEF_DIR, CONFIG_FILE), 'version: 3\n');
    scriptedGit.files = [
      { path: 'src/edited.ts' },
      { path: `${TREES_DIR}/` },
      { path: `${SPLITBRIEF_DIR}/` },
    ];
    scriptedGit.notAdded = [`${TREES_DIR}/`, `${SPLITBRIEF_DIR}/`];

    const { report } = await collectReadiness({ projectDir: tempDir });

    const dirty = flattenReadinessChecks(report.sections).find(
      (check) => check.id === 'repo.dirty-worktree',
    );
    expect(dirty?.metadata).toEqual({ dirtyCount: 1, untrackedCount: 0 });
    expect(dirty?.details).toEqual(['Examples: src/edited.ts']);
  });

  it.each([
    ['the .splitbrief/ line SPLITBRIEF added', 'node_modules/\n.splitbrief/\n', undefined],
    [
      'an operator edit beside it',
      'node_modules/\ndist/\n.splitbrief/\n',
      { dirtyCount: 1, untrackedCount: 0 },
    ],
  ])(
    'counts a changed .gitignore holding %s as dirty only for the operator edit',
    async (_case, working, metadata) => {
      writeFileSync(join(tempDir, '.gitignore'), working);
      scriptedGit.headFiles = { '.gitignore': 'node_modules/\n' };
      scriptedGit.files = [{ path: '.gitignore' }];

      const { report } = await collectReadiness({ projectDir: tempDir });

      const dirty = flattenReadinessChecks(report.sections).find(
        (check) => check.id === 'repo.dirty-worktree',
      );
      expect(dirty?.metadata).toEqual(metadata);
    },
  );

  it('ignores only the explicit session being resumed', async () => {
    const sessionId = '2026-04-18-resume-session';
    writeSessionState(tempDir, sessionId, 'implementing');
    writeActive({ projectDir: tempDir, sessionId });

    const resumed = await collectReadiness({
      projectDir: tempDir,
      config: makeConfig(),
      resumeSession: { projectDir: tempDir, sessionId },
    });
    const other = await collectReadiness({
      projectDir: tempDir,
      config: makeConfig(),
      resumeSession: { projectDir: tempDir, sessionId: 'another-session' },
    });

    expect(
      flattenReadinessChecks(resumed.report.sections).some((check) =>
        check.id.startsWith('repo.active-session-'),
      ),
    ).toBe(false);
    expect(
      flattenReadinessChecks(other.report.sections).some((check) =>
        check.id.startsWith('repo.active-session-'),
      ),
    ).toBe(true);
  });
});

describe('collectReadiness repository posture from a scripted git', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('collect-scripted-git');
    scriptedGit.repo = { isRepo: true, branch: 'main' };
    scriptedGit.commands = [];
  });

  afterEach(() => {
    scriptedGit.repo = undefined;
    cleanupTempDir(tempDir);
  });

  function repoChecks(report: Awaited<ReturnType<typeof collectReadiness>>['report']) {
    return report.sections.find((section) => section.id === 'repo')?.checks ?? [];
  }

  it('admits a repository with no git author identity without asking git for one', async () => {
    // A config object handed in directly skips the loader that now rejects
    // per-task, so this is the input that used to trigger the identity probe.
    const config = makeConfig();
    const { report } = await collectReadiness({
      projectDir: tempDir,
      config: { ...config, workflow: { ...config.workflow, git: { commitStrategy: 'per-task' } } },
    });

    expect(repoChecks(report)).toEqual([
      { id: 'repo.git', severity: 'ok', summary: 'Git repository detected.' },
    ]);
    expect(scriptedGit.commands.length).toBeGreaterThan(0);
    expect(
      scriptedGit.commands.filter(
        (args) =>
          args[0] === 'var' ||
          args[0] === 'config' ||
          args.some((arg) => /user\.(name|email)|_IDENT$/.test(arg)),
      ),
    ).toEqual([]);
  });

  it('blocks on an active session whose heartbeat is live', async () => {
    const sessionId = '2026-04-18-live-heartbeat';
    writeSessionState(tempDir, sessionId, 'implementing');
    writeSessionLockfile(tempDir, sessionId);
    writeActive({ projectDir: tempDir, sessionId });

    const { report } = await collectReadiness({ projectDir: tempDir, config: makeConfig() });

    expect(repoChecks(report)).toContainEqual(
      expect.objectContaining({
        id: 'repo.active-session-live',
        severity: 'blocker',
        metadata: { sessionId, live: true },
      }),
    );
    expect(report.status).toBe('blocked');
  });

  it('keeps a stale active session marker informational', async () => {
    const sessionId = '2026-04-18-stale-marker';
    writeSessionState(tempDir, sessionId, 'implementing');
    writeSessionLockfile(tempDir, sessionId, {
      lastAliveMs: Date.now() - HEARTBEAT_STALENESS_MS - 1,
    });
    writeActive({ projectDir: tempDir, sessionId });

    const { report } = await collectReadiness({ projectDir: tempDir, config: makeConfig() });

    expect(repoChecks(report)).toContainEqual(
      expect.objectContaining({
        id: 'repo.active-session-stale',
        severity: 'info',
        metadata: { sessionId, live: false },
      }),
    );
  });

  it('warns about a detached HEAD in terms of the uncommitted run changes', async () => {
    scriptedGit.repo = { isRepo: true, branch: 'HEAD' };

    const { report } = await collectReadiness({ projectDir: tempDir, config: makeConfig() });

    const detached = repoChecks(report).find((check) => check.id === 'repo.detached-head');
    expect(detached?.severity).toBe('warning');
    expect(detached?.details?.join(' ')).toContain('uncommitted');
    expect(detached?.details?.join(' ')).not.toMatch(/per-task|checkpoint/i);
  });

  it('blocks a project directory that is not a git repository', async () => {
    scriptedGit.repo = { isRepo: false, branch: 'main' };

    const { report } = await collectReadiness({ projectDir: tempDir, config: makeConfig() });

    expect(repoChecks(report)).toEqual([
      expect.objectContaining({ id: 'repo.not-git', severity: 'blocker' }),
    ]);
  });
});

const itUnix = process.platform === 'win32' ? it.skip : it;

describe('collectReadiness config loader warnings', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('collect-config-warnings');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  function writeMinimalV3Config(projectDir: string): string {
    const filePath = join(projectDir, SPLITBRIEF_DIR, CONFIG_FILE);
    mkdirSync(join(projectDir, SPLITBRIEF_DIR), { recursive: true });
    writeFileSync(
      filePath,
      [
        'version: 3',
        'planner:',
        '  kind: cli',
        '  tool: claude-code',
        'implementer:',
        '  kind: api',
        '  provider: ollama',
        '  api_base: http://localhost:11434/v1',
        '  model: qwen2.5-coder:7b',
      ].join('\n'),
    );
    return filePath;
  }

  itUnix('surfaces a 0666 permission warning exactly once', async () => {
    const configPath = writeMinimalV3Config(tempDir);
    chmodSync(configPath, 0o666);

    const { report } = await collectReadiness({ projectDir: tempDir });
    const configWarnings = flattenReadinessChecks(report.sections).filter(
      (check) => check.id === 'config.warning',
    );

    expect(configWarnings).toHaveLength(1);
    expect(configWarnings[0]?.summary).toContain('overly permissive');
  });

  it('names each retired workflow key once, the load-mapped approve level included', async () => {
    const configPath = writeMinimalV3Config(tempDir);
    writeFileSync(
      configPath,
      `${readFileSync(configPath, 'utf8')}\nworkflow:\n  approve: all\n  mode: speckit\n`,
    );
    chmodSync(configPath, 0o600);

    const { report } = await collectReadiness({ projectDir: tempDir });
    const retired = flattenReadinessChecks(report.sections)
      .filter((check) => check.id === 'config.warning' && check.summary.includes('was retired'))
      .map((check) => check.summary);

    expect(retired).toEqual([
      'workflow.mode was retired and is ignored: every run plans in one session. Delete workflow.mode.',
      'workflow.approve "all" was retired; using "plan": the plan waits for your approval before the build. Set approve to plan or none.',
    ]);
  });

  it('reports an unsupported config version as a blocking invalid config', async () => {
    writeConfigYaml(tempDir, {
      version: 2,
      planner: { kind: 'cli', tool: 'claude-code' },
      implementer: {
        kind: 'api',
        provider: 'ollama',
        service: 'ollama',
        offering: 'local',
        apiBase: 'http://localhost:11434/v1',
        model: 'qwen2.5-coder:7b',
      },
    });

    const { report } = await collectReadiness({ projectDir: tempDir });
    const invalid = flattenReadinessChecks(report.sections).find(
      (check) => check.id === 'config.invalid',
    );

    expect(invalid?.severity).toBe('blocker');
    expect(invalid?.details?.[0]).toContain('Unsupported config version: 2');
  });
});
