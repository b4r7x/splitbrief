import { readPackageJson } from '../../../../core/project-meta.js';
import type { PackageScriptsReadinessInput } from '../../../../core/readiness/checks/validation.js';
import { parseShellCommand } from '../../../../utils/parse-shell-command.js';
import { isRecord } from '../../../../utils/type-guards.js';
import { isApprovedNpmRun } from './command.js';

/** The scripts of the workspace's package.json, the way a plan check reads them. */
export function readPackageScripts(projectDir: string): PackageScriptsReadinessInput {
  const pkg = readPackageJson(projectDir);
  if (pkg === null) return { packageJsonExists: false, scripts: {} };
  const scripts = pkg['scripts'];
  if (!isRecord(scripts)) return { packageJsonExists: true, scripts: {} };
  const entries = Object.entries(scripts).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return { packageJsonExists: true, scripts: Object.fromEntries(entries) };
}

/**
 * Why an approved `npm run <script>` check finds no script to run: package.json is missing, or it
 * does not define the script. Null for any other command, and for an npm option before `--`, such
 * as `-w` or `--prefix`, which can name another package.json. The change lacks the script, so a
 * check that runs finds it failed, and a check an answer writes is refused unless a task adds it.
 */
export function missingNpmScript(
  command: string,
  npmScriptsApproved: boolean,
  packageScripts: PackageScriptsReadinessInput,
): string | null {
  const tokens = parseShellCommand(command);
  const script = tokens[2];
  if (!isApprovedNpmRun(tokens, npmScriptsApproved) || script === undefined) return null;
  const npmArgs = tokens.includes('--') ? tokens.slice(0, tokens.indexOf('--')) : tokens;
  if (npmArgs.some((token) => token.startsWith('-'))) return null;
  if (!packageScripts.packageJsonExists) {
    return 'runs an npm script, but package.json was not found';
  }
  if (!Object.hasOwn(packageScripts.scripts, script)) {
    return `runs the npm script ${script}, which package.json does not define`;
  }
  return null;
}
