import { describe, expect, it } from 'vitest';
import { captureText } from '../../../lib/process/errors.js';
import { failureKeys } from './extract-failure-keys.js';
import { checkFailureText } from './failure-text.js';
import type { CheckRunResult } from './run-checks.js';
import { boundedOutputTail } from './stage.js';

const NOISE = Array.from(
  { length: 200 },
  (_line, index) => `{"type":"task_end","id":${index},"endedAt":1760000000000,"durationMs":63}`,
).join('\n');

/** The project a check runs in; the workspace fixtures below keep their packages under it. */
const PROJECT = '/home/me/ws';

function red(stdout: string, stderr = ''): CheckRunResult {
  const capture = { stdout, stderr, complete: true };
  return {
    checkId: 'V1',
    status: 'fail',
    output: boundedOutputTail(captureText(capture)),
    failure: failureKeys({ capture, exitCode: 1 }, PROJECT),
    command: 'npm run test-ci',
    exitCode: 1,
  };
}

/** The text of a red without failure keys: its head line, then the output tail when it printed any. */
function said(quote: string, stdout: string, stderr = ''): string {
  const head = `check V1 did not pass (fail): exited with code 1${quote}`;
  const tail = captureText({ stdout, stderr, complete: true });
  return tail.trim() === '' ? head : `${head}\nOutput tail:\n${tail}`;
}

describe('checkFailureText', () => {
  // Live run 2026-10-09: the 4k tail of `npm run test-ci` was an event-log line.
  it('names the failing test and its assertion message when the output tail is noise', () => {
    const run = red(
      [
        ' FAIL  src/a.test.ts > a > adds',
        'AssertionError: expected 1 to be 2',
        ' ❯ src/a.test.ts:3:5',
        NOISE,
      ].join('\n'),
    );
    expect(run.output).not.toContain('AssertionError');

    const text = checkFailureText(run);

    expect(text).toMatch(/^check V1 did not pass \(fail\): 1 failure\n/);
    expect(text).toContain(
      'Failures:\n- src/a.test.ts::a > adds\n  AssertionError: expected 1 to be 2\nOutput tail:\n',
    );
    expect(text.indexOf('AssertionError')).toBeLessThan(text.indexOf('Output tail:'));
  });

  it('lists a diagnostic key as its own line', () => {
    const diagnostic = 'src/b.ts(4,2): error TS2322: Type number is not assignable to type string.';

    expect(checkFailureText(red(`${diagnostic}\n${NOISE}`))).toContain(
      `Failures:\n- ${diagnostic}\nOutput tail:\n`,
    );
  });

  it('lists at most ten keys and counts the rest', () => {
    const lines = Array.from(
      { length: 12 },
      (_line, index) => `src/c${index}.ts(1,1): error TS2304: Cannot find name x.`,
    );
    const text = checkFailureText(red(lines.join('\n')));

    expect(text).toContain('12 failures');
    expect(text).toContain('- src/c9.ts(1,1)');
    expect(text).not.toContain('- src/c10.ts(1,1)');
    expect(text).toContain('and 2 more\nOutput tail:');
  });

  it('keeps the output of a red that names no failure', () => {
    expect(checkFailureText(red('broken'))).toBe(said(': broken', 'broken'));
    expect(checkFailureText(red('step one\nstep two'))).toBe(
      'check V1 did not pass (fail): exited with code 1 without diagnostics\nOutput tail:\nstep one\nstep two',
    );
    expect(checkFailureText(red(''))).toBe(
      'check V1 did not pass (fail): exited with code 1 without diagnostics',
    );
  });

  it('clips and redacts listed keys and messages before the bounded tail', () => {
    const text = checkFailureText(
      red(
        [
          ` FAIL  src/a.test.ts > API_KEY="test-key" ${'x'.repeat(400)}`,
          `AssertionError: PASSWORD="test-password" ${'y'.repeat(400)}`,
          NOISE,
        ].join('\n'),
      ),
    );
    const listing = text.split('Output tail:')[0] ?? '';

    expect(listing).toContain('API_KEY="***REDACTED***"');
    expect(listing).toContain('PASSWORD="***REDACTED***"');
    expect(text).not.toContain('test-key');
    expect(text).not.toContain('test-password');
    for (const line of listing.split('\n').filter((line) => /^- |^ {2}/.test(line))) {
      expect(line.length).toBeLessThanOrEqual(302);
    }
  });

  // Live run 2026-10-19: npm's output starts with a blank line, so the head line read
  // `check K7 did not pass (fail):` and the attempt record kept nothing else.
  it('names how a red without failure keys failed on its head line', () => {
    const banner = '\n> app@1.0.0 test\n> node check.js\n\n';

    expect(checkFailureText(red(`${banner}Error: totals differ`))).toBe(
      said(': Error: totals differ', `${banner}Error: totals differ`),
    );
    expect(checkFailureText(red(`${banner}totals differ: expected 3, got 4`))).toBe(
      said(': totals differ: expected 3, got 4', `${banner}totals differ: expected 3, got 4`),
    );
    expect(checkFailureText(red(`${banner}Error: totals differ\n    at main (check.js:3:9)`))).toBe(
      `check V1 did not pass (fail): exited with code 1: Error: totals differ\nOutput tail:\n${banner}Error: totals differ\n    at main (check.js:3:9)`,
    );
  });

  // Captured from npm 10.9, pnpm 9.15, 10.34 and 11.21, yarn 1.22 and 4.5 and bun 1.3 on 2026-10-22,
  // each stream through its own pipe: the product holds a check's stdout, then its stderr.
  const ONE = 'totals differ: expected 3, got 4\n';
  const PNPM_10_NOTE =
    ' WARN  Local package.json exists, but node_modules missing, did you mean to install?\n';
  const PNPM_11_NOTE =
    '[WARN]  Local package.json exists, but node_modules missing, did you mean to install?\n';
  const YARN_1_LINK =
    'info Visit https://yarnpkg.com/en/docs/cli/run for documentation about this command.\n';
  const YARN_1_LICENSE = 'warning package.json: No license field\n';

  it.each([
    ['npm, on stderr', '\n> app@1.0.0 one\n> node one.js\n\n', ONE],
    ['npm, on stdout', `\n> app@1.0.0 outone\n> node outone.js\n\n${ONE}`, ''],
    [
      'pnpm 9, on stderr',
      '\n> app@1.0.0 one /home/me/app\n> node one.js\n\n ELIFECYCLE  Command failed with exit code 1.\n',
      ONE,
    ],
    [
      'pnpm 10, on stdout',
      `\n> app@1.0.0 outone /home/me/app\n> node outone.js\n\n${ONE} ELIFECYCLE  Command failed with exit code 1.\n${PNPM_10_NOTE}`,
      '',
    ],
    [
      'pnpm 11, on stderr',
      `[ELIFECYCLE] Command failed with exit code 1.\n${PNPM_11_NOTE}`,
      `$ node one.js\n${ONE}`,
    ],
    [
      'pnpm 11, on stdout',
      `${ONE}[ELIFECYCLE] Command failed with exit code 1.\n`,
      '$ node outone.js\n',
    ],
    [
      'yarn 1, on stderr',
      `yarn run v1.22.22\n$ node one.js\n${YARN_1_LINK}`,
      `${YARN_1_LICENSE}${ONE}error Command failed with exit code 1.\n`,
    ],
    [
      'yarn 1, on stdout',
      `yarn run v1.22.22\n$ node outone.js\n${ONE}${YARN_1_LINK}`,
      `${YARN_1_LICENSE}error Command failed with exit code 1.\n`,
    ],
    ['yarn 4, on stderr', '', ONE],
    ['yarn 4, on stdout', ONE, ''],
    ['bun, on stderr', '', `$ node one.js\n${ONE}error: script "one" exited with code 1\n`],
    ['bun, on stdout', ONE, '$ node outone.js\nerror: script "outone" exited with code 1\n'],
  ])('quotes the one line a script printed through %s', (_manager, stdout, stderr) => {
    expect(checkFailureText(red(stdout, stderr))).toBe(
      said(': totals differ: expected 3, got 4', stdout, stderr),
    );
  });

  // Captured from npm 10.9, pnpm 9.15 and 11.21, yarn 1.22 and bun 1.3 on 2026-10-22: `test` scripts,
  // workspace, filtered and recursive runs, and a yarn script that runs another one.
  const WEB = `${PROJECT}/packages/web`;
  const PNPM_9_NOTE =
    ' WARN   Local package.json exists, but node_modules missing, did you mean to install?\n';
  const YARN_1_WORKSPACE_FAILED = `error Command failed.\nExit code: 1\nCommand: /usr/local/bin/node\nArguments: /home/me/.cache/node/corepack/v1/yarn/1.22.22/lib/cli.js run one\nDirectory: ${WEB}\nOutput:\n\n`;

  it.each([
    [
      'pnpm 9 test, on stderr',
      '\n> app@1.0.0 test /home/me/app\n> node s.js one\n\n ELIFECYCLE  Test failed. See above for more details.\n',
      ONE,
    ],
    [
      'pnpm 9 test, on stdout',
      `\n> app@1.0.0 test /home/me/app\n> node s.js outone\n\n${ONE} ELIFECYCLE  Test failed. See above for more details.\n`,
      '',
    ],
    [
      'pnpm 11 test, on stderr',
      '[ELIFECYCLE] Test failed. See above for more details.\n',
      `$ node s.js one\n${ONE}`,
    ],
    [
      'pnpm 11 test, on stdout',
      `${ONE}[ELIFECYCLE] Test failed. See above for more details.\n`,
      '$ node s.js outone\n',
    ],
    [
      'npm -w',
      '\n> web@1.0.0 one\n> node s.js one\n\n',
      `${ONE}npm error Lifecycle script \`one\` failed with error:\nnpm error code 1\nnpm error path ${WEB}\nnpm error workspace web@1.0.0\nnpm error location ${WEB}\nnpm error command failed\nnpm error command sh -c node s.js one\n`,
    ],
    [
      'pnpm 9 --filter',
      `\n> web@1.0.0 one ${WEB}\n> node s.js one\n\n${WEB}:\n ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  web@1.0.0 one: \`node s.js one\`\nExit status 1\n${PNPM_9_NOTE}`,
      ONE,
    ],
    [
      'pnpm 11 --filter',
      `${WEB}:\n[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] web@1.0.0 one: \`node s.js one\`\nExit status 1\n${PNPM_11_NOTE}`,
      `$ node s.js one\n${ONE}`,
    ],
    [
      'yarn 1 workspace',
      `yarn workspace v1.22.22\nyarn run v1.22.22\n$ node s.js one\n${YARN_1_LINK}info Visit https://yarnpkg.com/en/docs/cli/workspace for documentation about this command.\n`,
      `${ONE}error Command failed with exit code 1.\n${YARN_1_WORKSPACE_FAILED}`,
    ],
    [
      'a yarn 1 script that runs another one',
      `yarn run v1.22.22\n$ yarn one\n$ node s.js one\n${YARN_1_LINK}${YARN_1_LINK}`,
      `${ONE}error Command failed with exit code 1.\nerror Command failed with exit code 1.\n`,
    ],
    [
      'pnpm 11 --filter, in a package directory with a space',
      `${PROJECT}/packages/my web:\n[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] web@1.0.0 one: \`node s.js one\`\nExit status 1\n${PNPM_11_NOTE}`,
      `$ node s.js one\n${ONE}`,
    ],
    [
      'pnpm 9 --filter, in a package directory outside the project',
      `\n> web@1.0.0 one /srv/shared/packages/web\n> node s.js one\n\n/srv/shared/packages/web:\n\u2009ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL\u2009 web@1.0.0 one: \`node s.js one\`\nExit status 1\n${PNPM_9_NOTE}`,
      ONE,
    ],
    [
      'pnpm 9 --filter --no-bail, in a scoped package',
      `\n> @acme/web@1.0.0 one ${WEB}\n> node s.js one\n\n\u2009ERR_PNPM_RECURSIVE_FAIL\u2009 \n\n\nSummary: 1 fails, 0 passes\n\n${WEB}:\n\u2009ERROR\u2009 @acme/web@1.0.0 one: \`node s.js one\`\nExit status 1\n${PNPM_9_NOTE}`,
      ONE,
    ],
    [
      'pnpm 11 --filter --no-bail, in a scoped package',
      `[ERR_PNPM_RECURSIVE_FAIL] \n\n\nSummary: 1 fails, 0 passes\n\n${WEB}:\n[ERROR] @acme/web@1.0.0 one: \`node s.js one\`\nExit status 1\n${PNPM_11_NOTE}`,
      `$ node s.js one\n${ONE}`,
    ],
    ['bun --filter', `web one: ${ONE}web one: Exited with code 1\n`, ''],
  ])('quotes the one line a script printed through %s', (_manager, stdout, stderr) => {
    expect(checkFailureText(red(stdout, stderr))).toBe(
      said(': totals differ: expected 3, got 4', stdout, stderr),
    );
  });

  // Captured from npm 10.9, pnpm 9.15 and 11.21, yarn 1.22 and 4.5 and bun 1.3 on 2026-10-22: chained,
  // pre and nested scripts, where the manager prints its lines once per script, and recursive and
  // workspace runs over two packages where one fails.
  const APP = '/home/me/app';
  const API = `${PROJECT}/packages/api`;
  const ROWS = 'expected 200 rows, read 198\n';
  const PNPM_9_FAILED = ' ELIFECYCLE  Command failed with exit code 1.\n';
  const PNPM_11_FAILED = '[ELIFECYCLE] Command failed with exit code 1.\n';

  it.each([
    [
      'a pnpm 9 chain',
      `\n> app@1.0.0 c2p ${APP}\n> pnpm lintq && pnpm unit\n\n\n> app@1.0.0 lintq ${APP}\n> node s.js okq\n\n\n> app@1.0.0 unit ${APP}\n> node s.js one\n\n${PNPM_9_FAILED}${PNPM_9_FAILED}`,
      ONE,
    ],
    [
      'a nested pnpm 9 script',
      `\n> app@1.0.0 nwp ${APP}\n> pnpm unitw\n\n\n> app@1.0.0 unitw ${APP}\n> node s.js one --fatal-warnings\n\n${PNPM_9_FAILED}${PNPM_9_FAILED}`,
      ONE,
    ],
    ['a pnpm 11 pre script', PNPM_11_FAILED, `$ node s.js okq\n$ node s.js one\n${ONE}`],
    [
      'a pnpm 11 chain',
      `${PNPM_11_FAILED}${PNPM_11_FAILED}`,
      `$ pnpm lintq && pnpm unitw\n$ node s.js okq\n$ node s.js one --fatal-warnings\n${ONE}`,
    ],
    [
      'a nested pnpm 11 script',
      `${PNPM_11_FAILED}${PNPM_11_FAILED}`,
      `$ pnpm unitw\n$ node s.js one --fatal-warnings\n${ONE}`,
    ],
    [
      'a yarn 1 chain',
      `yarn run v1.22.22\n$ yarn lintq && yarn unitw\n$ node s.js okq\n$ node s.js one --fatal-warnings\n${YARN_1_LINK}${YARN_1_LINK}`,
      `${ONE}error Command failed with exit code 1.\nerror Command failed with exit code 1.\n`,
    ],
    [
      'a bun chain',
      '',
      `$ bun run lintq && bun run unitw\n$ node s.js okq\n$ node s.js one --fatal-warnings\n${ONE}error: script "unitw" exited with code 1\nerror: script "c3b" exited with code 1\n`,
    ],
    [
      'a nested bun script',
      '',
      `$ bun run unitw\n$ node s.js one --fatal-warnings\n${ONE}error: script "unitw" exited with code 1\nerror: script "nwb" exited with code 1\n`,
    ],
    [
      'a yarn 1 -s chain',
      `$ node s.js okq\n$ node s.js one --fatal-warnings\n${YARN_1_LINK}`,
      `${ONE}error Command failed with exit code 1.\n`,
    ],
    [
      'a nested yarn 1 -s script',
      `$ node s.js one --fatal-warnings\n${YARN_1_LINK}`,
      `${ONE}error Command failed with exit code 1.\n`,
    ],
    [
      'pnpm 11 -r --no-bail',
      `Scope: 2 of 3 workspace projects\npackages/api nb$ node s2.js okq\npackages/web nb$ node s.js one\npackages/api nb: Done\npackages/web nb: ${ONE}packages/web nb: Failed\n[ERR_PNPM_RECURSIVE_FAIL] \n\n\nSummary: 1 fails, 1 passes\n\n${WEB}:\n[ERROR] web@1.0.0 nb: \`node s.js one\`\nExit status 1\n${PNPM_11_NOTE}`,
      '',
    ],
    [
      'pnpm 11 --filter --no-bail, on stdout',
      `${ONE}[ERR_PNPM_RECURSIVE_FAIL] \n\n\nSummary: 1 fails, 0 passes\n\n${WEB}:\n[ERROR] web@1.0.0 ob: \`node s.js outone\`\nExit status 1\n${PNPM_11_NOTE}`,
      '$ node s.js outone\n',
    ],
    [
      'pnpm 9 -r --no-bail',
      `Scope: 2 of 3 workspace projects\npackages/api nb$ node s2.js okq\npackages/web nb$ node s.js one\npackages/api nb: Done\npackages/web nb: ${ONE}packages/web nb: Failed\n ERR_PNPM_RECURSIVE_FAIL  \n\n\nSummary: 1 fails, 1 passes\n\n${WEB}:\n ERROR  web@1.0.0 nb: \`node s.js one\`\nExit status 1\n${PNPM_9_NOTE}`,
      '',
    ],
    [
      'pnpm 10 --filter --no-bail',
      `\n> web@1.0.0 nb ${WEB}\n> node s.js one\n\n ERR_PNPM_RECURSIVE_FAIL  \n\n\nSummary: 1 fails, 0 passes\n\n${WEB}:\n ERROR  web@1.0.0 nb: \`node s.js one\`\nExit status 1\n${PNPM_9_NOTE}`,
      ONE,
    ],
    [
      'pnpm 9 --filter --no-bail, on stdout',
      `\n> web@1.0.0 ob ${WEB}\n> node s.js outone\n\n${ONE} ERR_PNPM_RECURSIVE_FAIL  \n\n\nSummary: 1 fails, 0 passes\n\n${WEB}:\n ERROR  web@1.0.0 ob: \`node s.js outone\`\nExit status 1\n${PNPM_9_NOTE}`,
      '',
    ],
    [
      'pnpm 11 -r over the whole workspace',
      `Scope: all 3 workspace projects\npackages/api nb$ node s2.js okq\npackages/web nb$ node s.js one\npackages/web nb: ${ONE}packages/api nb: Done\npackages/web nb: Failed\n${WEB}:\n[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] web@1.0.0 nb: \`node s.js one\`\nExit status 1\n${PNPM_11_NOTE}`,
      '',
    ],
    [
      'pnpm 9 -r over the whole workspace',
      `Scope: all 3 workspace projects\npackages/api nb$ node s2.js okq\npackages/web nb$ node s.js one\npackages/web nb: ${ONE}packages/api nb: Done\npackages/web nb: Failed\n${WEB}:\n ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  web@1.0.0 nb: \`node s.js one\`\nExit status 1\n${PNPM_9_NOTE}`,
      '',
    ],
  ])('quotes the one line a script printed through %s', (_manager, stdout, stderr) => {
    expect(checkFailureText(red(stdout, stderr))).toBe(
      said(': totals differ: expected 3, got 4', stdout, stderr),
    );
  });

  it.each([
    [
      'pnpm 11 -r',
      `Scope: 2 of 3 workspace projects\npackages/api tw$ node t.js okq\npackages/web tw$ node t.js fail -Werror\npackages/api tw: Done\npackages/web tw: ${ROWS}packages/web tw: Failed\n${WEB}:\n[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] web@1.0.0 tw: \`node t.js fail -Werror\`\nExit status 1\n${PNPM_11_NOTE}`,
      '',
    ],
    [
      'yarn 1 workspaces run',
      `yarn workspaces v1.22.22\n\n> api\nyarn run v1.22.22\n$ node t.js okq\nDone in 0.43s.\n\n> web\nyarn run v1.22.22\n$ node t.js fail\n${YARN_1_LINK}info Visit https://yarnpkg.com/en/docs/cli/workspaces for documentation about this command.\n`,
      `${ROWS}error Command failed with exit code 1.\n${YARN_1_WORKSPACE_FAILED.replace('run one', 'run fone')}`,
    ],
    [
      'yarn 4 workspaces foreach',
      `${ROWS}The command failed in workspace web@workspace:packages/web with exit code 1\nFailed with errors in 0s 260ms\n`,
      '',
    ],
    [
      'bun --filter over two packages',
      `api fone: Exited with code 0\nweb fone: ${ROWS}web fone: Exited with code 1\n`,
      '',
    ],
  ])('quotes the one line the packages printed through %s', (_manager, stdout, stderr) => {
    expect(checkFailureText(red(stdout, stderr))).toBe(
      said(': expected 200 rows, read 198', stdout, stderr),
    );
  });

  it.each([
    [
      'npm --workspaces',
      '\n> api@1.0.0 test\n> node t.js apifail\n\n\n> web@1.0.0 test\n> node t.js fail\n\n',
      `api: route /health returned 503\nnpm error Lifecycle script \`test\` failed with error:\nnpm error code 1\nnpm error path ${API}\nnpm error workspace api@1.0.0\nnpm error location ${API}\nnpm error command failed\nnpm error command sh -c node t.js apifail\n\n${ROWS}npm error Lifecycle script \`test\` failed with error:\nnpm error code 1\nnpm error path ${WEB}\nnpm error workspace web@1.0.0\nnpm error location ${WEB}\nnpm error command failed\nnpm error command sh -c node t.js fail\n`,
    ],
    [
      'pnpm 11 -r --no-bail',
      `Scope: 2 of 3 workspace projects\npackages/api test$ node t.js apifail\npackages/web test$ node t.js fail\npackages/api test: api: route /health returned 503\npackages/web test: ${ROWS}packages/web test: Failed\npackages/api test: Failed\n[ERR_PNPM_RECURSIVE_FAIL] \n\n\nSummary: 2 fails, 0 passes\n\n${API}:\n[ERROR] api@1.0.0 test: \`node t.js apifail\`\nExit status 1\n\n${WEB}:\n[ERROR] web@1.0.0 test: \`node t.js fail\`\nExit status 1\n${PNPM_11_NOTE}${PNPM_11_NOTE}`,
      '',
    ],
  ])(
    'says a run through %s whose two failed packages printed a line each exited without diagnostics',
    (_manager, stdout, stderr) => {
      expect(checkFailureText(red(stdout, stderr))).toBe(
        said(' without diagnostics', stdout, stderr),
      );
    },
  );

  // Captured from pre-commit 4 and from a script that logs with bracket levels on 2026-10-22: a
  // program's own `[ERROR]` line is its error line, not pnpm's.
  const PRE_COMMIT_ERROR =
    '[ERROR] The hook `t` specifies `additional_dependencies` but is using language `unsupported` which does not install an environment.  Perhaps you meant to use a specific language?';
  const PORT_MISSING = '[ERROR] config key "port" is missing';

  it.each([
    ['pre-commit', PRE_COMMIT_ERROR, `${PRE_COMMIT_ERROR}\n`, ''],
    [
      'pre-commit through npm',
      PRE_COMMIT_ERROR,
      `\n> pc@1.0.0 lint\n> /home/me/venv/bin/pre-commit run --all-files\n\n${PRE_COMMIT_ERROR}\n`,
      '',
    ],
    ['a script', PORT_MISSING, '', `${PORT_MISSING}\n`],
    [
      'a yarn 1 script',
      PORT_MISSING,
      `yarn run v1.22.22\n$ node s.js errlabel\n${YARN_1_LINK}`,
      `${PORT_MISSING}\nerror Command failed with exit code 1.\n`,
    ],
    [
      'a pnpm 11 script',
      'Error: config.yml is invalid',
      `[ELIFECYCLE] Command failed with exit code 1.\n${PNPM_11_NOTE}`,
      '$ node s.js errabove\nError: config.yml is invalid\n[ERROR] aborting\n',
    ],
  ])('quotes the error line %s prints in brackets', (_program, quote, stdout, stderr) => {
    expect(checkFailureText(red(stdout, stderr))).toBe(said(`: ${quote}`, stdout, stderr));
  });

  // Captured from npm 10.9, pnpm 11.21 and yarn 1.22 on 2026-10-22: npm or npx is the program that fails.
  const NPX_CANCELED =
    'npm error npx canceled due to missing packages and no YES option: ["prettier@3.9.10"]';
  const NPM_LOG =
    'npm error A complete log of this run can be found in: /home/me/.npm/_logs/debug-0.log\n';

  it.each([
    ['npx --no-install', NPX_CANCELED, '', `${NPX_CANCELED}\n${NPM_LOG}`],
    [
      'an npm script',
      NPX_CANCELED,
      '\n> proj@1.0.0 fmt\n> npx --no-install prettier --check .\n\n',
      `${NPX_CANCELED}\n${NPM_LOG}`,
    ],
    [
      'a pnpm 11 script',
      NPX_CANCELED,
      PNPM_11_FAILED,
      `$ npx --no-install prettier --check .\n${NPX_CANCELED}\n${NPM_LOG}`,
    ],
    [
      'a yarn 1 script',
      NPX_CANCELED,
      `yarn run v1.22.22\n$ npx --no-install prettier --check .\n${YARN_1_LINK}`,
      `${NPX_CANCELED}\n${NPM_LOG}error Command failed with exit code 1.\n`,
    ],
    [
      'npm ls',
      'npm error code ELSPROBLEMS',
      'p2@1.0.0 /home/me/p2\n└── UNMET DEPENDENCY left-pad@1.3.0\n\n',
      `npm error code ELSPROBLEMS\nnpm error missing: left-pad@1.3.0, required by p2@1.0.0\n${NPM_LOG}`,
    ],
  ])('quotes the error npm printed through %s', (_form, quote, stdout, stderr) => {
    expect(checkFailureText(red(stdout, stderr))).toBe(said(`: ${quote}`, stdout, stderr));
  });

  // Captured on 2026-10-22 from a script that a SIGKILL ended: pnpm 11 prints no failure line then.
  it.each([
    [
      'pnpm 11',
      '',
      '$ node p.js err1 sig\npage 404.html is missing\n',
      ': page 404.html is missing',
    ],
    ['pnpm 11, a quiet script', '', '$ node p.js quiet sig\n', ' without diagnostics'],
    [
      'bun',
      '',
      '$ node p.js err1 sig\npage 404.html is missing\nerror: script "sig" was terminated by signal SIGKILL (Forced quit)\n',
      ': error: script "sig" was terminated by signal SIGKILL (Forced quit)',
    ],
  ])(
    'never quotes the command of a script a signal ended through %s',
    (_manager, stdout, stderr, quote) => {
      const capture = { stdout, stderr, complete: true };
      const run: CheckRunResult = {
        checkId: 'V1',
        status: 'fail',
        output: boundedOutputTail(captureText(capture)),
        failure: failureKeys({ capture, exitCode: undefined }, '/repo'),
        command: 'npm run test-ci',
      };
      expect(checkFailureText(run)).toBe(
        `check V1 did not pass (fail): failed${quote}\nOutput tail:\n${captureText(capture)}`,
      );
    },
  );

  it.each([
    ['npm', '\n> app@1.0.0 quiet\n> node -e "process.exit(1)"\n\n', ''],
    [
      'pnpm 9',
      '\n> app@1.0.0 quiet /home/me/app\n> node -e "process.exit(1)"\n\n ELIFECYCLE  Command failed with exit code 1.\n',
      '',
    ],
    [
      'pnpm 11',
      `[ELIFECYCLE] Command failed with exit code 1.\n${PNPM_11_NOTE}`,
      '$ node -e "process.exit(1)"\n',
    ],
    [
      'yarn 1',
      `yarn run v1.22.22\n$ node -e "process.exit(1)"\n${YARN_1_LINK}`,
      `${YARN_1_LICENSE}error Command failed with exit code 1.\n`,
    ],
    ['yarn 4', '', ''],
    ['bun', '', '$ node -e "process.exit(1)"\nerror: script "quiet" exited with code 1\n'],
  ])(
    'says a script run through %s that printed nothing exited without diagnostics',
    (_manager, stdout, stderr) => {
      expect(checkFailureText(red(stdout, stderr))).toBe(
        said(' without diagnostics', stdout, stderr),
      );
    },
  );

  it.each([
    [
      'pnpm 11',
      'checking 12 pages\n[ELIFECYCLE] Command failed with exit code 1.\n',
      '$ node check-error-pages.js --mixed\nError: page 404.html is missing\n',
    ],
    [
      'bun',
      'checking 12 pages\n',
      '$ node check-error-pages.js --mixed\nError: page 404.html is missing\nerror: script "mixed" exited with code 1\n',
    ],
  ])(
    'quotes the error line a script printed on stderr after its stdout through %s',
    (_manager, stdout, stderr) => {
      expect(checkFailureText(red(stdout, stderr))).toBe(
        `check V1 did not pass (fail): exited with code 1: Error: page 404.html is missing\nOutput tail:\n${captureText({ stdout, stderr, complete: true })}`,
      );
    },
  );

  it('never quotes the command a package manager prints', () => {
    const fatal = 'node --test --fatal-warnings check.js';
    const thrown = 'TypeError: totals is not a function\n    at main (check.js:3:9)\n';
    for (const [stdout, stderr] of [
      [`\n> app@1.0.0 test\n> ${fatal}\n\n`, thrown],
      [
        `yarn run v1.22.22\n$ ${fatal}\n${YARN_1_LINK}`,
        `${thrown}error Command failed with exit code 1.\n`,
      ],
      ['[ELIFECYCLE] Command failed with exit code 1.\n', `$ ${fatal}\n${thrown}`],
      ['', `$ ${fatal}\n${thrown}error: script "test" exited with code 1\n`],
    ] as const) {
      expect(checkFailureText(red(stdout, stderr))).toMatch(
        /^check V1 did not pass \(fail\): exited with code 1: TypeError: totals is not a function\nOutput tail:\n/,
      );
    }
    for (const [stdout, stderr] of [
      [`${ONE}[ELIFECYCLE] Command failed with exit code 1.\n`, `$ ${fatal}\n`],
      [ONE, `$ ${fatal}\nerror: script "test" exited with code 1\n`],
    ] as const) {
      expect(checkFailureText(red(stdout, stderr))).toBe(
        said(': totals differ: expected 3, got 4', stdout, stderr),
      );
    }
  });

  it('keeps the warning and command lines a script prints itself', () => {
    const logged = '[INFO] checking 12 pages\n[WARN] page 404.html is missing\n';
    for (const [stdout, stderr] of [
      [`\n> app@1.0.0 logwarn\n> node logwarn.js\n\n${logged}`, ''],
      [
        `yarn run v1.22.22\n$ node logwarn.js\n${logged}${YARN_1_LINK}`,
        'error Command failed with exit code 1.\n',
      ],
      [
        `${logged}[ELIFECYCLE] Command failed with exit code 1.\n${PNPM_11_NOTE}`,
        '$ node logwarn.js\n',
      ],
      [
        `Scope: 2 of 3 workspace projects\npackages/api lw$ node -e 0\npackages/web lw$ node lw.js\npackages/api lw: Done\nchecking 12 pages\n[WARN] page 404.html is missing\npackages/web lw: Failed\n${PROJECT}/packages/web:\n[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] web@1.0.0 lw: \`node lw.js\`\nExit status 1\n${PNPM_11_NOTE}`,
        '',
      ],
    ] as const) {
      expect(checkFailureText(red(stdout, stderr))).toBe(
        `check V1 did not pass (fail): exited with code 1 without diagnostics\nOutput tail:\n${captureText({ stdout, stderr, complete: true })}`,
      );
    }
    for (const [quote, stdout, stderr] of [
      [
        'WARN  config file missing, using defaults',
        '\n> app@1.0.0 warn\n> node warn.js\n\nWARN  config file missing, using defaults\n',
        '',
      ],
      [
        'WARN  config file missing, using defaults',
        `WARN  config file missing, using defaults\n[ELIFECYCLE] Command failed with exit code 1.\n${PNPM_11_NOTE}`,
        '$ node warn.js\n',
      ],
      [
        '$ cargo build --release',
        '\n> app@1.0.0 dollar\n> node dollar.js\n\n$ cargo build --release\n',
        '',
      ],
      [
        '[WARN] page 404.html is missing',
        `yarn run v1.22.22\n$ node p.js warnB1\n[WARN] page 404.html is missing\n${YARN_1_LINK}`,
        `${YARN_1_LICENSE}error Command failed with exit code 1.\n`,
      ],
      ['Done in 0.43s.', '\n> app@1.0.0 done\n> node done.js\n\nDone in 0.43s.\n', ''],
      [
        '> api',
        `yarn run v1.22.22\n$ node p.js\n> api\n${YARN_1_LINK}`,
        'error Command failed with exit code 1.\n',
      ],
      [
        'warning page 404.html is missing',
        `yarn run v1.22.22\n$ node t.js warn\n${YARN_1_LINK}`,
        'warning page 404.html is missing\nerror Command failed with exit code 1.\n',
      ],
      [
        'Files with stale snapshots:',
        `Files with stale snapshots:\n[ERR_PNPM_RECURSIVE_FAIL] \n\n\nSummary: 1 fails, 0 passes\n\n${PROJECT}/packages/web:\n[ERROR] web@1.0.0 colon: \`node s.js colon\`\nExit status 1\n${PNPM_11_NOTE}`,
        '$ node s.js colon\n',
      ],
      [
        'src/a.ts:',
        `\n> web@1.0.0 colon ${PROJECT}/packages/web\n> node s.js colon\n\nsrc/a.ts:\n\u2009ERR_PNPM_RECURSIVE_FAIL\u2009 \n\n\nSummary: 1 fails, 0 passes\n\n${PROJECT}/packages/web:\n\u2009ERROR\u2009 web@1.0.0 colon: \`node s.js colon\`\nExit status 1\n${PNPM_9_NOTE}`,
        '',
      ],
    ] as const) {
      expect(checkFailureText(red(stdout, stderr))).toBe(said(`: ${quote}`, stdout, stderr));
    }
  });

  it('quotes the line above the package line pnpm prints for the package in its own directory', () => {
    // pnpm prints the directory line only for a package outside its own directory: `pnpm -r` in a
    // one-package project, `pnpm -F .`, and `pnpm --filter <root>` at a workspace root print none.
    const pnpm9 = (script: string, line: string) =>
      `\n> single@1.0.0 ${script} ${PROJECT}\n> node s.js ${script}\n\n${line}\n ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  single@1.0.0 ${script}: \`node s.js ${script}\`\nExit status 1\n WARN   Local package.json exists, but node_modules missing, did you mean to install?\n`;
    const pnpm10 = (script: string, line: string) =>
      `\n> single@1.0.0 ${script} ${PROJECT}\n> node s.js ${script}\n\n${line}\n ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  single@1.0.0 ${script}: \`node s.js ${script}\`\nExit status 1\n`;
    const pnpm11 = (script: string, line: string) =>
      `${line}\n[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] single@1.0.0 ${script}: \`node s.js ${script}\`\nExit status 1\n`;
    for (const line of [
      'Error in 2 files:',
      'Files with stale snapshots:',
      '/srv/data/import.csv: Error reading header:',
    ]) {
      for (const [stdout, stderr] of [
        [pnpm9('x', line), ''],
        [pnpm10('x', line), ''],
        [pnpm11('x', line), '$ node s.js x\n'],
      ] as const) {
        expect(checkFailureText(red(stdout, stderr))).toBe(said(`: ${line}`, stdout, stderr));
      }
    }
  });

  it('quotes a path in the workspace relative to it', () => {
    const line = `Error: cannot read ${PROJECT}/packages/web/data/in.csv`;
    for (const [stdout, stderr] of [
      [`\n> web@1.0.0 x ${PROJECT}/packages/web\n> node s.js x\n\n${line}\n`, ''],
      [
        `${line}\n[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] web@1.0.0 x: \`node s.js x\`\nExit status 1\n`,
        '$ node s.js x\n',
      ],
    ] as const) {
      expect(checkFailureText(red(stdout, stderr))).toBe(
        said(': Error: cannot read packages/web/data/in.csv', stdout, stderr),
      );
    }
  });

  it('reads every `$ <command>` line as the echo of the package manager that prints one', () => {
    for (const [stdout, stderr] of [
      [
        `yarn run v1.22.22\n$ node dollar.js\n$ cargo build --release\n${YARN_1_LINK}`,
        `${YARN_1_LICENSE}error Command failed with exit code 1.\n`,
      ],
      [
        '$ cargo build --release\n',
        '$ node dollar.js\nerror: script "dollar" exited with code 1\n',
      ],
    ] as const) {
      expect(checkFailureText(red(stdout, stderr))).toBe(
        said(' without diagnostics', stdout, stderr),
      );
    }
  });

  it('keeps the output tail when the quote cuts the one line a script printed', () => {
    const line = `totals differ for ${Array.from({ length: 60 }, (_n, index) => `row${index}`).join(', ')}`;
    const text = checkFailureText(red(line));

    expect(text).toMatch(
      /^check V1 did not pass \(fail\): exited with code 1: totals differ for row0, .*…\n/,
    );
    expect(text).toContain(`Output tail:\n${line}`);
  });

  it('quotes a one-line TAP diagnostic without its comment mark', () => {
    expect(checkFailureText(red('# Error: totals differ'))).toBe(
      said(': Error: totals differ', '# Error: totals differ'),
    );
  });

  it('keeps the output of a check that could not run', () => {
    expect(checkFailureText({ checkId: 'V2', status: 'refused', output: 'names no program' })).toBe(
      'check V2 did not pass (refused): names no program',
    );
  });

  it('names the fix task keys that remain before the other failures', () => {
    const own = 'src/a.test.ts::a > adds';
    const gone = 'src/d.ts(2,1): error TS2322: Type number is not assignable to type string.';
    const other = 'src/legacy.ts(3,7): error TS2322: Type number is not assignable to type string.';
    const run = red(
      [' FAIL  src/a.test.ts > a > adds', 'AssertionError: expected 1 to be 2', other, NOISE].join(
        '\n',
      ),
    );

    const text = checkFailureText(run, {
      carried: { failureKeys: [own, gone], sharedWith: new Map(), exempt: false },
    });

    expect(text.split('\n')[0]).toBe(
      'check V1 did not pass (fail): 1\u00a0of\u00a0your\u00a02\u00a0failures\u00a0remains, 1\u00a0other\u00a0left\u00a0for\u00a0their\u00a0fix\u00a0tasks\u00a0or\u00a0the\u00a0next\u00a0review',
    );
    expect(text).toContain(
      [
        'Your failures that remain:',
        `- ${own}`,
        '  AssertionError: expected 1 to be 2',
        "Other failures, not this brief's job:",
        `- ${other}`,
        'Output tail:',
      ].join('\n'),
    );
    expect(text).not.toContain(gone);
  });

  it('lists a remaining failure an unfinished sibling also carries under that sibling', () => {
    const own = 'src/a.ts(1,14): error TS2322: Type number is not assignable to type string.';
    const shared = 'src/b.ts(2,1): error TS2322: Type number is not assignable to type string.';
    const other = 'src/c.ts(3,7): error TS2322: Type number is not assignable to type string.';

    const text = checkFailureText(red([shared, other].join('\n')), {
      carried: {
        failureKeys: [own, shared],
        sharedWith: new Map([[shared, ['T025']]]),
        exempt: false,
      },
    });

    expect(text).toContain(
      [
        'check V1 did not pass (fail): 1\u00a0of\u00a0your\u00a02\u00a0failures\u00a0gone, 1\u00a0left\u00a0to\u00a0T025, 1\u00a0other\u00a0left\u00a0for\u00a0their\u00a0fix\u00a0tasks\u00a0or\u00a0the\u00a0next\u00a0review',
        'Left to T025:',
        `- ${shared}`,
        "Other failures, not this brief's job:",
        `- ${other}`,
      ].join('\n'),
    );
  });

  it('lists a moved diagnostic the fix task owns at its new line', () => {
    const carried = 'src/a.ts(1,14): error TS2322: Type number is not assignable to type string.';
    const moved = 'src/a.ts(5,14): error TS2322: Type number is not assignable to type string.';

    const text = checkFailureText(red(moved), {
      carried: { failureKeys: [carried], sharedWith: new Map(), exempt: false },
    });

    expect(text).toContain(
      `your\u00a01\u00a0failure\u00a0remains\nYour failures that remain:\n- ${moved}`,
    );
  });

  it('shares ten places between Go tests and diagnostics, keeping each listed test message', () => {
    const run = red(
      [
        ...Array.from(
          { length: 10 },
          (_line, index) =>
            `--- FAIL: Test${index} (0.00s)\n    x_test.go:${index + 1}: got ${index}, want 20`,
        ),
        NOISE,
      ].join('\n'),
    );
    const text = checkFailureText(run);
    const listing = text.split('Output tail:')[0] ?? '';

    expect(run.output).not.toContain('got');
    expect(listing).toContain('20 failures');
    expect(listing.match(/^- Test\d+$/gm)).toHaveLength(5);
    expect(listing.match(/^- x_test.go:/gm)).toHaveLength(5);
    for (let index = 0; index < 5; index++) {
      expect(listing).toContain(`- Test${index}\n  x_test.go:${index + 1}: got ${index}, want 20`);
    }
    expect(listing).toContain('and 10 more');
    expect(text.endsWith(run.output)).toBe(true);
  });

  it('uses spare diagnostic places for tests without excluding the one diagnostic', () => {
    const text = checkFailureText(
      red(
        [
          ...Array.from(
            { length: 10 },
            (_line, index) =>
              ` FAIL  src/a.test.ts > test ${index}\nAssertionError: expected ${index} to be 20`,
          ),
          'src/b.ts(4,2): error TS2322',
          NOISE,
        ].join('\n'),
      ),
    );
    const listing = text.split('Output tail:')[0] ?? '';

    expect(listing.match(/^- src\/a.test.ts::/gm)).toHaveLength(9);
    expect(listing).toContain('- src/b.ts(4,2): error TS2322');
    expect(listing).toContain('and 1 more');
  });

  it('limits the keys and messages to the selected file and keeps all keys without a selection', () => {
    const run = red(
      [
        ' FAIL  src/a.test.ts > adds',
        'AssertionError: expected 1 to be 2',
        ' FAIL  src/b.test.ts > subtracts',
        'AssertionError: expected 3 to be 4',
      ].join('\n'),
    );
    const text = checkFailureText(run, { file: 'src/a.test.ts' });

    expect(text).toContain(
      '1 failure\nFailures:\n- src/a.test.ts::adds\n  AssertionError: expected 1 to be 2',
    );
    expect(text).not.toContain('src/b.test.ts');
    expect(text).not.toContain('expected 3 to be 4');
    expect(text).not.toContain('Output tail:');
    expect(run.output).toContain('src/b.test.ts');
    expect(checkFailureText(run)).toContain('2 failures');
    expect(checkFailureText(run)).toContain(
      '- src/b.test.ts::subtracts\n  AssertionError: expected 3 to be 4',
    );
  });

  it.each(['src/lib.rs', null])('keeps unassigned Rust failures with input file %s', (file) => {
    const run = red('test tests::adds ... FAILED\ntest tests::subtracts ... FAILED');
    const text = checkFailureText(run, { file });

    expect(text).toContain('2 failures\nFailures:\n- tests::adds\n- tests::subtracts');
    expect(text).not.toContain('0 failures');
    if (file === null) expect(text).toContain('Output tail:');
    else expect(text).not.toContain('Output tail:');
  });

  it('keeps unassigned failures alongside only the selected file diagnostics', () => {
    const run = red('test tests::adds ... FAILED\nsrc/a.ts(1,1): error A\nsrc/b.ts(1,1): error B');
    const text = checkFailureText(run, { file: 'src/a.ts' });

    expect(text).toContain('2 failures\nFailures:\n- tests::adds\n- src/a.ts(1,1): error A');
    expect(text).not.toContain('src/b.ts');
    expect(text).not.toContain('error B');
  });

  it('labels new and pre-existing failures within the ten-key listing bound', () => {
    const old = Array.from(
      { length: 10 },
      (_line, index) => `src/old.ts(${index + 1},1): error old`,
    );
    const fresh = 'src/new.ts(1,1): error new';
    const run = { ...red([...old, fresh, NOISE].join('\n')), preExisting: old };
    const text = checkFailureText(run);
    const listing = text.split('Output tail:')[0] ?? '';

    expect(listing).toContain(
      `New failures:\n- ${fresh}\nPre-existing failures (also red at the run base):\n- ${old[0]}`,
    );
    expect(listing.match(/^- /gm)).toHaveLength(10);
    expect(listing).toContain('and 1 more');
    expect(listing).not.toContain(old[9]);
  });

  it('keeps unassigned Go test keys without another file diagnostic message', () => {
    const run = red(
      [
        '--- FAIL: TestA (0.00s)',
        '    a_test.go:12: got 1, want 2',
        '--- FAIL: TestB (0.00s)',
        '    b_test.go:14: got 3, want 4',
      ].join('\n'),
    );
    const text = checkFailureText(run, { file: 'b_test.go' });

    expect(text).toContain('- TestA\n- TestB\n  b_test.go:14: got 3, want 4');
    expect(text).not.toContain('a_test.go');
    expect(text).not.toContain('got 1, want 2');
    expect(checkFailureText(run)).toContain('- TestA\n  a_test.go:12: got 1, want 2');
  });

  it('uses the placeholder reason for a file-scoped incomplete capture', () => {
    const text = checkFailureText(
      {
        checkId: 'V1',
        status: 'fail',
        output: 'src/b.ts(1,1): error B',
        failure: {
          keys: ['output over the capture limit'],
          placeholder: 'output over the capture limit',
        },
      },
      { file: 'src/a.ts' },
    );

    expect(text).toBe('check V1 did not pass (fail): output over the capture limit');
    expect(text).not.toContain('src/b.ts');
  });
});
