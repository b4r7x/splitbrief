import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SetupScreen } from '../../../src/app/screens/setup.js';
import { SettingsOverlay } from '../../../src/app/overlays/settings.js';
import { configPath } from '../../../src/core/config/load/document.js';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { glyph } from '../../../src/lib/glyphs.js';
import { configStore } from '../../../src/stores/project/config.js';
import { detectionStore } from '../../../src/stores/project/detection.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { overlayStore } from '../../../src/stores/ui/overlay.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome as createTrustHome } from '#testing/helpers/trust-home.js';
import {
  cli,
  createStopContinueFixture,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

let fixture: StopContinueFixture | undefined;
let home: ReturnType<typeof createTrustHome> | undefined;
let restorePath: (() => void) | undefined;

afterEach(() => {
  resetAllStores();
  vi.unstubAllEnvs();
  restorePath?.();
  home?.restore();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
});

function freshProject(gitignore = 'node_modules/\n.splitbrief/\n') {
  const base = createStopContinueFixture(() => '');
  const projectDir = join(base.tmpDir, 'onboarding');
  mkdirSync(projectDir);
  createTestGitRepo(projectDir, {
    '.gitignore': gitignore,
    'package.json': '{"scripts":{"test":"node --test"}}\n',
  });
  fixture = { ...base, projectDir };
  home = createTrustHome('e2e-first-run-doctor');
  const bin = join(base.tmpDir, 'bin');
  mkdirSync(bin);
  restorePath = activateSafeCliShimPath(bin);
  const offline = join(base.tmpDir, 'offline.mjs');
  writeFileSync(
    offline,
    "globalThis.fetch = async () => { throw new Error('Network disabled in first-run diagnostics'); };\n",
  );
  vi.stubEnv('NODE_OPTIONS', `--import=${offline}`);
  vi.stubEnv('XDG_CONFIG_HOME', join(home.home, 'config'));
  vi.stubEnv('XDG_DATA_HOME', join(home.home, 'data'));
  mkdirSync(join(home.home, '.claude'));
  writeFileSync(join(home.home, '.claude', '.credentials.json'), '{"fixture":true}\n');
  writeFakeNodeCli(
    bin,
    'claude',
    `
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('claude ${CLI_TOOL_CATALOG['claude-code'].compatibility.testedVersion}');
else if (args.includes('--help')) console.log('Claude Code fixture');
else if (args[0] === 'auth') console.log(JSON.stringify({ loggedIn: true }));
else { console.error('Unexpected model call'); process.exitCode = 1; }
`,
  );
  return fixture;
}

describe('e2e: first-run diagnostics', () => {
  it('initializes without writing a retired worktree ignore and reports one missing-config blocker', async () => {
    const target = freshProject();
    const before = readFileSync(join(target.projectDir, '.gitignore'), 'utf8');
    const missing = await cli(target, ['doctor']);
    expect(missing.exitCode, missing.stderr).toBe(1);
    expect(missing.stdout).toContain('(1 blocker, 0 warnings)');
    const initialized = await cli(target, ['init', '--yes']);
    expect(initialized.exitCode, initialized.stderr).toBe(0);
    expect(existsSync(configPath(target.projectDir))).toBe(true);
    expect(readFileSync(join(target.projectDir, '.gitignore'), 'utf8')).toBe(before);
    expect(readFileSync(join(target.projectDir, '.gitignore'), 'utf8')).not.toContain('.trees/');
    const report = await cli(target, ['doctor']);
    expect(report.stdout).not.toContain('repo.dirty-worktree');
    expect(report.stdout).not.toContain('.trees');
  });

  it('initializes a clean checkout that ignores .splitbrief/ outside .gitignore without dirtying it', async () => {
    const target = freshProject('node_modules/\n');
    appendFileSync(join(target.projectDir, '.git', 'info', 'exclude'), '.splitbrief/\n');
    const status = () =>
      execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
        cwd: target.projectDir,
        encoding: 'utf8',
      });
    expect(status()).toBe('');

    const initialized = await cli(target, ['init', '--yes']);
    expect(initialized.exitCode, initialized.stderr).toBe(0);
    expect(existsSync(configPath(target.projectDir))).toBe(true);
    expect(readFileSync(join(target.projectDir, '.gitignore'), 'utf8')).toBe('node_modules/\n');
    expect(status()).toBe('');
    const report = await cli(target, ['doctor'], { json: true, timeoutMs: 60_000 });
    expect(
      JSON.parse(report.stdout).report.checks.map((check: { id: string }) => check.id),
    ).not.toContain('repo.dirty-worktree');
  });

  it('adds the .splitbrief/ rule on a clean checkout that lacks one without a dirty-worktree warning', async () => {
    const target = freshProject('node_modules/\n');

    const initialized = await cli(target, ['init', '--yes']);
    expect(initialized.exitCode, initialized.stderr).toBe(0);
    expect(readFileSync(join(target.projectDir, '.gitignore'), 'utf8')).toBe(
      'node_modules/\n.splitbrief/\n',
    );
    const report = await cli(target, ['doctor'], { json: true, timeoutMs: 60_000 });
    expect(
      JSON.parse(report.stdout).report.checks.map((check: { id: string }) => check.id),
    ).not.toContain('repo.dirty-worktree');
  });

  it('diagnoses the config saved by Continue in Setup without warnings or repeated facts', async () => {
    const target = freshProject();
    resetAllStores();
    configStore.load(target.projectDir);
    routerStore.init({ screen: 'setup', onComplete: 'home' });
    const request = detectionStore.beginRefresh({
      contexts: { readiness: 'setup-ready', modelsDev: 'setup-models', cliModels: 'setup-cli' },
    });
    detectionStore.publish({
      request,
      result: {
        generation: 1,
        providers: [],
        cliTools: [cliDetectionFor('ready', 'claude-code')],
        catalog: {},
        cliModels: [],
      },
    });
    const ui = renderFeature(createElement(SetupScreen), { cols: 120, rows: 40 });
    try {
      await flushEffects();
      for (let step = 0; step < 15; step++) {
        const frame = stripAnsiStyles(ui.lastFrame() ?? '');
        if (frame.includes(`${glyph('liveBar')} Continue`)) break;
        ui.stdin.write('\u001b[B');
        await tick(20);
      }
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain(`${glyph('liveBar')} Continue`);
      ui.stdin.write('\r');
      await flushEffects();
      await vi.waitFor(() => expect(existsSync(configPath(target.projectDir))).toBe(true), {
        timeout: 5000,
      });
    } finally {
      ui.unmount();
    }
    const saved = readFileSync(configPath(target.projectDir), 'utf8');
    expect(loadConfig(target.projectDir).config.workflow.approve).toBe('plan');
    const text = await cli(target, ['doctor']);
    expect(text.exitCode, `${text.stdout}\n${text.stderr}`).toBe(0);
    expect(text.stdout).toContain('Plan approval: you approve the plan in the TUI.');
    expect(text.stdout).toContain('Headless runs approve the plan automatically');
    expect(text.stdout).toContain('(0 blockers, 0 warnings)');
    expect(text.stdout).toContain('PLAN Claude Code CLI');
    expect(text.stdout).toContain('BUILD Claude Code CLI');
    expect(text.stdout).not.toMatch(
      /runners\.|context\.|workflow\.|Command options:|00000000-0000|PLAN.*(?:take over|edit files)|1 blockers|1 warnings/,
    );
    const lines = text.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    expect(new Set(lines).size).toBe(lines.length);
    expect(text.stdout).not.toMatch(
      /tier-2|approval automation|fresh runner admission|arg vector|via profile|Profiles:|Write mode:|contextLength|auto-approved/,
    );
    const json = await cli(target, ['doctor'], { json: true, timeoutMs: 60_000 });
    expect(json.exitCode, json.stderr).toBe(0);
    const report = JSON.parse(json.stdout).report;
    expect(report.counts.blocker).toBe(0);
    expect(report.status).toBe('ready');
    expect(report.counts.warning).toBe(0);
    expect(
      report.checks.filter((check: { severity: string }) => check.severity === 'warning'),
    ).toEqual([]);
    for (const check of report.checks) expect(text.stdout).not.toContain(check.id);
    expect(readFileSync(configPath(target.projectDir), 'utf8')).toBe(saved);
  });

  it('directs a tight CLI BUILD budget to Settings and clears the warning after the edit', async () => {
    const target = freshProject();
    const initial = loadConfig(target.projectDir).config;
    writeConfig(target.projectDir, {
      ...initial,
      planner: { kind: 'cli', tool: 'claude-code' },
      implementer: { kind: 'cli', tool: 'claude-code', contextLength: 16_000 },
    });
    const before = await cli(target, ['doctor']);
    expect(before.stdout).toContain('context length 16000 may be tight.');
    expect(before.stdout).toContain('Settings > Tuning > Prompt budget');
    expect(before.stdout).not.toContain('implementer.contextLength');

    resetAllStores();
    configStore.load(target.projectDir);
    overlayStore.open('settings', 'implementer.contextLength');
    const ui = renderFeature(createElement(SettingsOverlay), { cols: 120, rows: 40 });
    try {
      await flushEffects();
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('Prompt budget');
      ui.stdin.write('\r');
      await tick(20);
      for (let index = 0; index < 5; index++) {
        ui.stdin.write('\u007f');
        await tick(20);
      }
      ui.stdin.write('64000');
      await tick(20);
      ui.stdin.write('\r');
      await vi.waitFor(() => {
        expect(loadConfig(target.projectDir).config.implementer.contextLength).toBe(64_000);
      });
    } finally {
      ui.unmount();
    }
    const after = await cli(target, ['doctor'], { json: true, timeoutMs: 60_000 });
    expect(after.exitCode, after.stderr).toBe(0);
    expect(JSON.parse(after.stdout).report.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'context.implementer.ok' })]),
    );
    expect(JSON.parse(after.stdout).report.checks).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'context.implementer.tight' })]),
    );
  });
});
