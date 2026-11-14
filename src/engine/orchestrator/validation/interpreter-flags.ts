/** The interpreter options that load code other than a script file. */
export const CODE_LOAD_FLAGS: ReadonlySet<string> = new Set([
  '-e',
  '--eval',
  '-r',
  '--require',
  '--import',
  '-i',
  '--input-type',
  '-c',
  '--command',
  '-p',
  '--print',
  '--run',
]);

export const INLINE_CODE_FLAGS: ReadonlySet<string> = new Set([
  ...CODE_LOAD_FLAGS,
  '-E',
  '--loader',
  '--experimental-loader',
]);

export const NODE_TEST_REPORTERS = new Set(['dot', 'junit', 'spec', 'tap', 'lcov']);
export const NODE_TEST_BOOLEAN_FLAGS = new Set([
  '--test',
  '--test-only',
  '--test-force-exit',
  '--test-update-snapshots',
]);
export const NODE_TEST_VALUE_FLAGS = new Set([
  '--test-concurrency',
  '--test-coverage-branches',
  '--test-coverage-exclude',
  '--test-coverage-functions',
  '--test-coverage-include',
  '--test-coverage-lines',
  '--test-name-pattern',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-shard',
  '--test-skip-pattern',
  '--test-timeout',
]);

/** Node's options that only parse the script: node runs no code of it. */
export const NODE_SYNTAX_CHECK_FLAGS: ReadonlySet<string> = new Set(['-c', '--check']);

/**
 * Whether node's options before its script only parse the script (`node --check x.js`). Any
 * other option can run it: `node --check --build-snapshot x.js` runs `x.js`.
 */
export function nodeParsesOnly(options: readonly string[]): boolean {
  return options.length > 0 && options.every((option) => NODE_SYNTAX_CHECK_FLAGS.has(option));
}
