import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { readPackageJson } from '../../project-meta.js';
import { INTERNAL_SKIP_DIRS } from '../../paths.js';
import { isRecord } from '../../../utils/type-guards.js';
import type { IsolationStrategy } from '../../schemas/enums.js';
import type { ReadinessCheck } from '../types.js';

const CARGO_WORKSPACE_RE = /^\[workspace\]/m;

const CHECKOUT_FIX =
  'Set `workflow.isolation: none` in .splitbrief/config.yaml to run in your checkout (recommended for this stack), or `workflow.isolation: worktree` to keep the worktree.';

/**
 * Stacks a run worktree cannot serve because they resolve into the checkout. With
 * `workflow.isolation` unset each one blocks and recommends the checkout, so the user
 * confirms the choice once by writing the key; `none` silences them, an explicit
 * worktree or staged copy keeps them as warnings.
 */
export function buildIsolationChecks(
  projectDir: string,
  isolation: IsolationStrategy | undefined,
): ReadinessCheck[] {
  if (isolation === 'none') return [];
  const checks: ReadinessCheck[] = [];
  const pkg = readPackageJson(projectDir);
  const workspaces = pkg === null ? undefined : pkg['workspaces'];
  let workspaceLinks =
    isNonEmptyArray(workspaces) ||
    (isRecord(workspaces) && isNonEmptyArray(workspaces['packages']));
  const pnpmPath = join(projectDir, 'pnpm-workspace.yaml');
  if (!workspaceLinks && existsSync(pnpmPath)) {
    const parsed: unknown = parse(readFileSync(pnpmPath, 'utf8'));
    workspaceLinks = isRecord(parsed) && isNonEmptyArray(parsed['packages']);
  }
  if (workspaceLinks) {
    checks.push({
      id: 'isolation.workspace-links',
      severity: 'warning',
      summary: 'The project links workspace packages through node_modules.',
      details: [
        "The worktree shares the checkout's node_modules, so a workspace package link resolves to the checkout's copy, not the worktree's edits.",
      ],
    });
  }
  const directories = [projectDir];
  let pythonEditable = false;
  venvs: for (const directory of directories) {
    if (!existsSync(join(directory, 'pyvenv.cfg'))) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && !INTERNAL_SKIP_DIRS.includes(entry.name)) {
          directories.push(join(directory, entry.name));
        }
      }
      continue;
    }
    const libDir = join(directory, 'lib');
    if (!existsSync(libDir)) continue;
    for (const entry of readdirSync(libDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('python')) continue;
      const sitePackages = join(libDir, entry.name, 'site-packages');
      if (!existsSync(sitePackages)) continue;
      if (
        readdirSync(sitePackages).some(
          (name) => name.endsWith('.egg-link') || name.startsWith('__editable__'),
        )
      ) {
        pythonEditable = true;
        break venvs;
      }
    }
  }
  if (pythonEditable) {
    checks.push({
      id: 'isolation.python-editable',
      severity: 'warning',
      summary: 'The project has a Python editable install in a venv under it.',
      details: [
        "The editable install points the interpreter at the checkout's sources, not the worktree's.",
      ],
    });
  }
  const cargoPath = join(projectDir, 'Cargo.toml');
  const targetPath = join(projectDir, 'target');
  if (
    existsSync(join(projectDir, 'go.work')) ||
    (existsSync(cargoPath) &&
      existsSync(targetPath) &&
      statSync(targetPath).isDirectory() &&
      CARGO_WORKSPACE_RE.test(readFileSync(cargoPath, 'utf8')))
  ) {
    checks.push({
      id: 'isolation.build-cache',
      severity: 'warning',
      summary: 'The project builds through a workspace rooted in the checkout.',
      details: ['The Go workspace or the Cargo build cache is tied to the checkout.'],
    });
  }
  if (isolation !== undefined) return checks;
  return checks.map((check) => ({
    ...check,
    severity: 'blocker',
    summary: `${check.summary} Run in your checkout.`,
    fix: CHECKOUT_FIX,
    nextAction: 'fix-config',
  }));
}

function isNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}
