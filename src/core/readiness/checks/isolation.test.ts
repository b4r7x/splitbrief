import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { buildIsolationChecks } from './isolation.js';

describe('buildIsolationChecks', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = createTempDir('readiness-isolation');
  });

  afterEach(() => {
    cleanupTempDir(projectDir);
  });

  function write(path: string, content: string): void {
    const full = join(projectDir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }

  it('warns for a monorepo fixture with workspace links', () => {
    write('package.json', JSON.stringify({ name: 'mono', workspaces: ['packages/*'] }));
    write('packages/a/package.json', JSON.stringify({ name: 'a' }));
    mkdirSync(join(projectDir, 'node_modules'));
    symlinkSync(join(projectDir, 'packages/a'), join(projectDir, 'node_modules/a'), 'dir');

    expect(realpathSync(join(projectDir, 'node_modules/a'))).toBe(
      realpathSync(join(projectDir, 'packages/a')),
    );
    const checks = buildIsolationChecks(projectDir);

    expect(checks).toHaveLength(1);
    expect(checks[0]?.id).toBe('isolation.workspace-links');
    expect(checks[0]?.severity).toBe('warning');
  });

  it('warns for a pnpm workspace that lists packages', () => {
    write('package.json', JSON.stringify({ name: 'mono' }));
    write('pnpm-workspace.yaml', 'packages:\n  - packages/*\n');

    expect(buildIsolationChecks(projectDir).map((check) => check.id)).toEqual([
      'isolation.workspace-links',
    ]);
  });

  it('warns for object-form package workspaces', () => {
    write('package.json', JSON.stringify({ workspaces: { packages: ['packages/*'] } }));

    expect(buildIsolationChecks(projectDir)).toEqual([
      expect.objectContaining({ id: 'isolation.workspace-links', severity: 'warning' }),
    ]);
  });

  it('propagates malformed pnpm workspace YAML', () => {
    write('pnpm-workspace.yaml', 'packages: [\n');

    expect(() => buildIsolationChecks(projectDir)).toThrow();
  });

  it('propagates a pnpm workspace read error', () => {
    mkdirSync(join(projectDir, 'pnpm-workspace.yaml'));

    expect(() => buildIsolationChecks(projectDir)).toThrow();
  });

  it('does not warn for a pnpm-workspace.yaml that holds only settings', () => {
    write('package.json', JSON.stringify({ name: 'app' }));
    write('pnpm-workspace.yaml', 'onlyBuiltDependencies:\n  - esbuild\n');

    expect(buildIsolationChecks(projectDir)).toEqual([]);
  });

  it('no warning for a plain package', () => {
    write('package.json', JSON.stringify({ name: 'app', scripts: { test: 'vitest' } }));

    expect(buildIsolationChecks(projectDir)).toEqual([]);
  });

  it('warns for a Python editable install in a venv under the project', () => {
    write('.venv/pyvenv.cfg', 'home = /usr/bin\n');
    write('.venv/lib/python3.12/site-packages/__editable__.app-0.1.pth', '/project/src\n');

    expect(buildIsolationChecks(projectDir).map((check) => check.id)).toEqual([
      'isolation.python-editable',
    ]);
  });

  it('warns for a legacy egg-link editable install', () => {
    write('venv/pyvenv.cfg', 'home = /usr/bin\n');
    write('venv/lib/python3.9/site-packages/app.egg-link', '/project\n.\n');

    expect(buildIsolationChecks(projectDir).map((check) => check.id)).toEqual([
      'isolation.python-editable',
    ]);
  });

  it.each([
    ['tools/.venv', '__editable__.app-0.1.pth'],
    ['tools/python/venv', 'app.egg-link'],
  ])('warns for a nested venv at %s with %s', (venv, marker) => {
    write(`${venv}/pyvenv.cfg`, 'home = /usr/bin\n');
    write(`${venv}/lib/python3.12/site-packages/${marker}`, '/project/src\n');

    expect(buildIsolationChecks(projectDir)).toEqual([
      expect.objectContaining({ id: 'isolation.python-editable', severity: 'warning' }),
    ]);
  });

  it('does not warn for a venv with only regular installs', () => {
    write('.venv/pyvenv.cfg', 'home = /usr/bin\n');
    write('.venv/lib/python3.12/site-packages/requests/__init__.py', '');

    expect(buildIsolationChecks(projectDir)).toEqual([]);
  });

  it('warns for a go.work file', () => {
    write('go.work', 'go 1.22\n\nuse ./svc\n');

    expect(buildIsolationChecks(projectDir).map((check) => check.id)).toEqual([
      'isolation.build-cache',
    ]);
  });

  it('warns for a Cargo workspace whose target lives in the checkout', () => {
    write('Cargo.toml', '[workspace]\nmembers = ["crates/*"]\n');
    mkdirSync(join(projectDir, 'target'));

    expect(buildIsolationChecks(projectDir).map((check) => check.id)).toEqual([
      'isolation.build-cache',
    ]);
  });

  it('does not warn for a Cargo workspace with no target in the checkout', () => {
    write('Cargo.toml', '[workspace]\nmembers = ["crates/*"]\n');

    expect(buildIsolationChecks(projectDir)).toEqual([]);
  });

  it('does not warn for a Cargo workspace with a regular target file', () => {
    write('Cargo.toml', '[workspace]\nmembers = ["crates/*"]\n');
    write('target', 'not a build cache\n');

    expect(buildIsolationChecks(projectDir)).toEqual([]);
  });

  it('does not warn for a single Cargo crate with a target', () => {
    write('Cargo.toml', '[package]\nname = "app"\n');
    mkdirSync(join(projectDir, 'target'));

    expect(buildIsolationChecks(projectDir)).toEqual([]);
  });
});
