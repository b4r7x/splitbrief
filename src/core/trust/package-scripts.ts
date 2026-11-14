import { withoutPackageSpec } from './path-classification.js';

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
// yarn installs `yarnpkg` as a second name; `isPackageManager` keeps its pinned policy, so the
// alias applies only where a script is read.
const PACKAGE_MANAGER_ALIASES = new Map([['yarnpkg', 'yarn']]);
// npm resolves a command through its aliases and any unique prefix, and reads camelCase as
// kebab-case, so `rum`, `ur`, `run-s` and `runS` all name `run-script`.
const NPM_RUN_ALIASES = new Set(['run', 'rum', 'urn', 'ur']);
const NPM_LIFECYCLE_ALIASES = new Map([
  ['test', 'test'],
  ['t', 'test'],
  ['tst', 'test'],
  ['tes', 'test'],
  ['start', 'start'],
  ['stop', 'stop'],
  ['sto', 'stop'],
  ['restart', 'restart'],
  ['restar', 'restart'],
  ['resta', 'restart'],
  ['rest', 'restart'],
  ['res', 'restart'],
  // npm install and its aliases (`npm i`, `npm add`, the `isntall` typos) plus `npm ci` all run
  // the root install lifecycle scripts (docs.npmjs.com/cli/v11/using-npm/scripts).
  ['install', 'install'],
  ['i', 'install'],
  ['in', 'install'],
  ['ins', 'install'],
  ['inst', 'install'],
  ['insta', 'install'],
  ['instal', 'install'],
  ['isnt', 'install'],
  ['isnta', 'install'],
  ['isntal', 'install'],
  ['isntall', 'install'],
  ['add', 'install'],
  ['ci', 'install'],
  ['clean-install', 'install'],
  ['ic', 'install'],
  ['install-clean', 'install'],
  ['isntall-clean', 'install'],
]);

function firstNonOptionIndex(tokens: readonly string[], start: number): number | null {
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined || token === '--') return null;
    if (token.startsWith('-') && token !== '-') continue;
    return i;
  }
  return null;
}

export function isPackageManager(name: string): boolean {
  return PACKAGE_MANAGERS.has(name);
}

function runsNamedScript(manager: string, command: string): boolean {
  if (manager !== 'npm') return command === 'run' || command === 'run-script';
  return NPM_RUN_ALIASES.has(command) || (command.length >= 4 && 'run-script'.startsWith(command));
}

// yarn, pnpm and bun run the script that a bare word names; npm does so only for its
// lifecycle commands.
export function packageManagerScriptName(tokens: readonly string[]): string | null {
  const name = withoutPackageSpec(tokens[0] ?? '');
  const manager = PACKAGE_MANAGER_ALIASES.get(name) ?? name;
  if (!isPackageManager(manager)) return null;

  const subcommandIndex = firstNonOptionIndex(tokens, 1);
  if (subcommandIndex === null) return null;

  const subcommand = tokens[subcommandIndex] ?? '';
  const command =
    manager === 'npm'
      ? subcommand.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
      : subcommand;
  if (runsNamedScript(manager, command)) {
    const scriptIndex = firstNonOptionIndex(tokens, subcommandIndex + 1);
    return scriptIndex === null ? null : (tokens[scriptIndex] ?? null);
  }

  if (manager !== 'npm') return subcommand;
  return NPM_LIFECYCLE_ALIASES.get(command) ?? null;
}

// A wrapper or another package manager can run the manager: `timeout 5 npm run check`,
// `npx npm run check` and `pnpm exec npm run check` run `check` too.
export function packageManagerScriptNames(tokens: readonly string[]): readonly string[] {
  return tokens.flatMap((_, index) => packageManagerScriptName(tokens.slice(index)) ?? []);
}

export function isPackageManagerScriptInvocation(tokens: readonly string[]): boolean {
  return packageManagerScriptName(tokens) !== null;
}

// npm install and npm ci run the full lifecycle chain in the documented order; the same names
// are read for every project that installs (including through yarn/pnpm/bun), so an install
// target that changes always invalidates trust. `--ignore-scripts` is not special-cased: extra
// invalidation is accepted over an environment-sensitive exclusion.
const NPM_INSTALL_SCRIPTS = [
  'preinstall',
  'install',
  'postinstall',
  'prepublish',
  'preprepare',
  'prepare',
  'postprepare',
] as const;

// A package manager runs `pre<name>` and `post<name>` around the script it names. For `restart`,
// pnpm also runs `stop` and `start`, and npm does when the project has no `restart` script.
export function scriptsRunFor(scriptName: string): readonly string[] {
  if (scriptName === 'install') return NPM_INSTALL_SCRIPTS;
  const names = scriptName === 'restart' ? ['stop', 'restart', 'start'] : [scriptName];
  return names.flatMap((name) => [`pre${name}`, name, `post${name}`]);
}
