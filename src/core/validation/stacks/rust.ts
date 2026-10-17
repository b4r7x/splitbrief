import { basename } from 'node:path';
import type { Stack } from './types.js';

export const rustStack: Stack = {
  id: 'rust',
  language: 'rust',
  markers: ['Cargo.toml'],
  test: () => 'cargo test',
  testFilePatterns: ['tests/*.rs'],
  testDirs: [],
  inlineTests: /#\[cfg\(test\)\]/,
  narrowing: { kind: 'cargo-target' },
  allowedCommands: ['cargo'],
};

type CargoSelection =
  | { kind: 'target'; flag: '--test' | '--example' | '--bench'; name: string }
  | { kind: 'module'; filter: string }
  | { kind: 'crate' };

export type CargoTarget = { crate: string; selection: CargoSelection };

const TARGET_FLAGS = new Map<string, '--test' | '--example' | '--bench'>([
  ['tests', '--test'],
  ['examples', '--example'],
  ['benches', '--bench'],
]);
const RUST_IDENT = /^[A-Za-z_]\w*$/;

/**
 * How cargo selects the tests of `path`, a file relative to its crate folder. A test, example or
 * bench file is a target by its name, and a file in a folder target belongs to that folder when the
 * folder holds a `main.rs`. A module has its path filter; any other source file runs the crate.
 */
export function cargoSelection(
  path: string,
  isFile: (cratePath: string) => boolean,
): CargoSelection | null {
  const slash = path.indexOf('/');
  if (slash === -1 || !path.endsWith('.rs')) return null;
  const root = path.slice(0, slash);
  const rest = path.slice(slash + 1).split('/');
  const flag = TARGET_FLAGS.get(root);
  if (flag !== undefined) {
    if (rest.length === 1) return { kind: 'target', flag, name: basename(path, '.rs') };
    const folder = path.slice(0, path.indexOf('/', slash + 1));
    return isFile(`${folder}/main.rs`) ? { kind: 'target', flag, name: basename(folder) } : null;
  }
  if (root !== 'src') return null;
  // A crate root names its tests without a module prefix; `src/a/b.rs` and `src/a/b/mod.rs`
  // name theirs `a::b::…`. A module loaded through `#[path]` has no such filter.
  const file = basename(path);
  if (rest[0] === 'bin' || (rest.length === 1 && (file === 'lib.rs' || file === 'main.rs'))) {
    return { kind: 'crate' };
  }
  const modules = [...rest.slice(0, -1), basename(file, '.rs')];
  if (modules.at(-1) === 'mod') modules.pop();
  return modules.length > 0 && modules.every((name) => RUST_IDENT.test(name))
    ? { kind: 'module', filter: `${modules.join('::')}::` }
    : { kind: 'crate' };
}

/**
 * The cargo arguments that run the tests of the targets: integration tests, examples and benches
 * by name, modules by their path filter, anything else by its whole crate. Targets that no single
 * cargo command selects have none.
 */
export function cargoTestArgs(targets: readonly (CargoTarget | null)[]): string[] | null {
  const parsed: CargoTarget[] = [];
  for (const target of targets) {
    if (target === null) return null;
    parsed.push(target);
  }
  const crate = parsed[0]?.crate;
  if (crate === undefined || parsed.some((target) => target.crate !== crate)) return null;
  const manifest = crate === '' ? [] : ['--manifest-path', `${crate}/Cargo.toml`];
  const selections = parsed.map((target) => target.selection);
  if (selections.every((selection) => selection.kind === 'target')) {
    return [...manifest, ...selections.flatMap((selection) => [selection.flag, selection.name])];
  }
  if (selections.every((selection) => selection.kind === 'module')) {
    return [...manifest, '--', ...selections.map((selection) => selection.filter)];
  }
  return manifest;
}
