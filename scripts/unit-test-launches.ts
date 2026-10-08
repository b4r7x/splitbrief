import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import config from '../vitest.config.js';

// Helpers build a real git repository or worktree, drive the run loop or Apply.
// Other markers launch git, use simple-git or create node shims and fake CLIs.
const LAUNCH_MARKER =
  /\b(createTestGitRepo|setupGitSessionProject|setupTaskProject|makeTaskWorkflowContext|createHeadlessGitProject|startApplyRun|withApplyRun|makeCopyingIsolation|makeWorktreeIsolation|makeWctx|createRunIsolation|installClaude\w*Shim|writeFakeCli|writeFakeNodeCli|writeCommandShim|writeContractShim|writeConflictProbeShim|installCompatibleCliShim|effectScenario|createCommandInvokeTestFixtures)\b|\b(runWorkflow|runTrackedWorkflow)\(|\b(execFileSync|execFile|execSync|spawnSync|spawn)\(\s*['"`]git\b|#!\/usr\/bin\/env node|#!\$\{process\.execPath\}|from 'simple-git'/;

type VitestProject = Readonly<{ name: string; include: string[]; exclude: string[] }>;

export function vitestProjects(): VitestProject[] {
  return (config.test?.projects ?? []).flatMap((entry) =>
    typeof entry === 'object' &&
    entry !== null &&
    'test' in entry &&
    typeof entry.test?.name === 'string'
      ? [
          {
            name: entry.test.name,
            include: entry.test.include ?? [],
            exclude: entry.test.exclude ?? [],
          },
        ]
      : [],
  );
}

export function projectFiles(name: string, root: string = process.cwd()): string[] {
  const project = vitestProjects().find((entry) => entry.name === name);
  if (project === undefined) throw new Error(`Vitest project not found: ${name}`);
  return globSync(project.include, { cwd: root, exclude: project.exclude }).sort();
}

export function findLaunchingUnitTests(root: string = process.cwd()): string[] {
  return projectFiles('unit', root).flatMap((file) => {
    const match = readFileSync(join(root, file), 'utf8').match(LAUNCH_MARKER);
    return match === null ? [] : [`${file}: ${match[0]}`];
  });
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  for (const violation of findLaunchingUnitTests()) console.log(violation);
}
