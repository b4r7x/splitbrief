import {
  FAILURE_KEY_PATH,
  fileFromFailureKey,
  isTestNodeKey,
} from '../../../core/review/fix-task.js';
import { realpathOrResolve } from '../../../core/trust/path-classification.js';
import { captureText, type ProcessOutputCapture } from '../../../lib/process/errors.js';
import { normalizeProjectRelativePath } from '../../../utils/path-patterns.js';
import { redactSecrets } from '../../../utils/redact.js';
import { truncateByChars } from '../../../utils/truncate.js';
import { failingTestKey, parseFailingTests, readNodeTap } from './test-failures.js';

/**
 * The keys of a red command: its failing tests by name and its diagnostic lines, else the lines of
 * an output that lists only whole paths. A timeout, an incomplete capture or a red that names no
 * failure has one placeholder key, and `placeholder` says how it failed, since that key names no
 * failure; it quotes the script's first error line, else its only line, without the lines its
 * package manager printed around it.
 * Output lines that name no file, such as an `npm` script banner or a `make` error summary, are not
 * diagnostic lines.
 * `messages` holds, per failing test key, the first line the runner printed under it (its
 * assertion message), read from the whole capture; a diagnostic key is its own line and has no
 * entry.
 */
export type FailureKeys = {
  keys: string[];
  placeholder?: string | undefined;
  messages?: ReadonlyMap<string, string> | undefined;
};

export function failureKeys(
  run: {
    capture: ProcessOutputCapture;
    timedOut?: true | undefined;
    exitCode?: number | undefined;
  },
  dir: string,
): FailureKeys {
  if (run.timedOut === true) return { keys: ['timed out'], placeholder: 'timed out' };
  if (!run.capture.complete) {
    return {
      keys: ['output over the capture limit'],
      placeholder: 'output over the capture limit',
    };
  }
  const output = relativeToDir(captureText(run.capture), dir);
  const tests = parseFailingTests(output);
  const extracted = extractFailureKeys(output);
  const keys = [
    ...new Set([...tests.map(failingTestKey), ...(extracted.diagnostics ? extracted.keys : [])]),
  ];
  const messages = new Map<string, string>();
  for (const test of tests) {
    const key = failingTestKey(test);
    if (test.message !== '' && !STACK_FRAME.test(test.message) && !messages.has(key)) {
      messages.set(key, test.message);
    }
  }
  if (keys.length > 0) return { keys, ...(messages.size > 0 && { messages }) };
  if (
    extracted.keys.length > 0 &&
    extracted.keys.every((line) => fileFromFailureKey(line) === normalizeProjectRelativePath(line))
  ) {
    return { keys: [...new Set(extracted.keys.map(normalizeProjectRelativePath))] };
  }
  // pnpm prints its directory line as an absolute path, so the lines are read before they turn relative.
  const lines = scriptLines(run.capture.stdout, run.capture.stderr, {
    signaled: run.exitCode === undefined,
  });
  const own = nonEmptyLines(relativeToDir(lines.join('\n'), dir));
  const said = errorLine(own) ?? onlyLine(own);
  if (run.exitCode === undefined) {
    return {
      keys: ['failed without diagnostics'],
      placeholder: said === undefined ? 'failed without diagnostics' : `failed: ${said}`,
    };
  }
  const key = `exited with code ${run.exitCode}`;
  return {
    keys: [key],
    placeholder: said === undefined ? `${key} without diagnostics` : `${key}: ${said}`,
  };
}

/**
 * The output with the paths under `dir` relative to it, under `dir` as given and under its real
 * path, which Node's test runner prints. The longer root goes first, so neither cuts the other.
 */
export function relativeToDir(output: string, dir: string): string {
  return [dir, realpathOrResolve(dir)]
    .sort((a, b) => b.length - a.length)
    .reduce((text, root) => text.replaceAll(`${root}/`, ''), output);
}

const ERROR_WORD = /\b\w*(?:error|exception)\b|\b(?:fatal|panic)\b/i;
const ERROR_LINE_CHARS = 200;

/** An output line as a placeholder quotes it: without its indent or a TAP `#` prefix. */
function quotedLineText(line: string): string {
  return line.replace(/^\s*#?\s*/, '').trimEnd();
}

function quote(line: string): string {
  return truncateByChars(redactSecrets(quotedLineText(line)), ERROR_LINE_CHARS);
}

/** The first line that reports an error; never a stack frame. */
function errorLine(lines: readonly string[]): string | undefined {
  const line = lines.find((raw) => {
    const text = quotedLineText(raw);
    return ERROR_WORD.test(text) && !STACK_FRAME.test(text);
  });
  return line === undefined ? undefined : quote(line);
}

/** The one line a script printed: its failure message. */
function onlyLine(lines: readonly string[]): string | undefined {
  const [line, ...rest] = lines;
  return line === undefined || rest.length > 0 ? undefined : quote(line);
}

/** `> <package>@<version> <script>`: npm and pnpm before 11 print it, then `> <command>`. */
const RUN_BANNER = /^> (?:@[^\s/]+\/)?[^\s@/]+@\S+ \S/;
/** pnpm prints this line when a script fails; pnpm before 11 pads its labels with thin spaces. */
const PNPM_FAILED = /^(?:\u2009ELIFECYCLE\u2009|\[ELIFECYCLE\]) (?:Command|Test) failed/;
/** pnpm 11 frames its labels in brackets, and it echoes the script command. */
const PNPM_11_LABEL = /^\[(?:ELIFECYCLE|ERR_PNPM_\w+)\]/;
/** The notes pnpm prints under its own lines. */
const PNPM_NOTE = /^(?:\[WARN\]|\u2009WARN\u2009) +\S/;
/**
 * A filtered or recursive pnpm run prints the package directory, unless the package is the one in
 * pnpm's own directory, then the package line, then the exit status; `--no-bail` prints an `ERR_PNPM_` line, then its summary, then one such block per failed
 * package. The package line names the package as `<label> <package>@<version> <script>: \`<command>\``.
 * A bare label loses its closing thin space with the line's trailing white space.
 */
const PNPM_RUN_FAILED = /^(?:\[ERR_PNPM_\w+\]|\u2009ERR_PNPM_\w+(?:\u2009|$))(?: |$)/;
const PNPM_RUN_PACKAGE =
  /^(?:\[(?:ERR_PNPM_\w+|ERROR)\]|\u2009(?:ERR_PNPM_\w+|ERROR)\u2009) +(?:@[^\s/]+\/)?[^\s@/]+@\S+ \S+: `/;
const PNPM_RUN_DETAIL = /^(?:Exit status \d+|Summary: \d+ fails?, \d+ pass(?:es)?)$/;
/** The package directory as pnpm prints it: absolute, with any white space in it, but no `: ` as a message has. */
const PNPM_RUN_DIRECTORY = /^\/(?!.*: ).*:$/;
/** `pnpm -r` heads its output with the scope and echoes each command as `<package> <script>$ <command>`. */
const PNPM_SCOPE = /^Scope: (?:all \d+|\d+ of \d+) workspace projects?$/;
const PNPM_RECURSIVE_ECHO = /^(\S+ \S+)\$ \S/;
/** `pnpm -r` heads each line of a script with `<package> <script>: ` and ends it with this status. */
const PNPM_RECURSIVE_STATUS = /^(?:Done|Failed)$/;
/** `bun --filter` heads each line of a script with `<package> <script>: ` and ends it with this line. */
const BUN_FILTER_EXITED = /^(\S+ \S+): Exited with code \d+$/;
/** pnpm 11, bun and yarn 1 print `$ <command>` before each script starts. */
const COMMAND_ECHO = /^\$ \S/;
/** bun prints this line when a script fails. */
const BUN_FAILED = /^error: script ".*" exited with code \d+$/;
const YARN_HEADER = /^yarn (?:run|workspace|workspaces) v\d/;
const YARN_LINK = /^info Visit https:\/\/yarnpkg\.com\//;
/** yarn 1 prints this line when a script fails; `yarn workspace` adds the block under it. */
const YARN_FAILED = /^error Command failed with exit code \d+\.$/;
const YARN_WORKSPACE_FAILED =
  /^(?:error Command failed\.|Exit code: \d+|(?:Command|Arguments|Directory): .*|Output:)$/;
/** yarn 1 reads the package manifest and warns about it; `yarn workspaces run` heads each package with `> <package>`. */
const YARN_WARNING = /^warning \S*package\.json: /;
const YARN_WORKSPACES_PACKAGE = /^> \S+$/;
const YARN_DONE = /^Done in \d+(?:\.\d+)?s\.$/;
/** yarn 4 `workspaces foreach` prints these lines when a script fails. */
const YARN_FOREACH_FAILED =
  /^(?:The command failed in workspace \S+ with exit code \d+|Failed with errors in \d.*)$/;
/** npm prints this block when a workspace script fails. */
const NPM_LIFECYCLE_FAILED = /^npm (?:error|ERR!) Lifecycle script /;
const NPM_ERROR = /^npm (?:error|ERR!) /;

function nonEmptyLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

/** The non-empty lines of a text without the banner pairs npm and pnpm before 11 print. */
export function withoutRunBanners(text: string): string[] {
  const lines = nonEmptyLines(text);
  return lines.filter(
    (line, index) =>
      !RUN_BANNER.test(line) &&
      !(index > 0 && RUN_BANNER.test(lines[index - 1] ?? '') && line.startsWith('> ')),
  );
}

type ManagerContext = {
  /** A manager that echoes the script command ran, or a signal ended the run before it said so. */
  echoes: boolean;
  /** yarn 1 ran: `yarn -s` hides its header, but not its link. */
  yarn: boolean;
  yarnWorkspaces: boolean;
  /** The `<package> <script>` heads `pnpm -r` and `bun --filter` put before a script's lines. */
  heads: ReadonlySet<string>;
};

/** The lines from `index` up to the end of the run of `pattern` lines that starts at `from`. */
function spanThrough(
  lines: readonly string[],
  index: number,
  from: number,
  pattern: RegExp,
): number {
  let end = from;
  while (end < lines.length && pattern.test(lines[end] ?? '')) end++;
  return end - index;
}

/** How many lines from `index` on pnpm printed: 0 when the line is not pnpm's. */
function pnpmSpan(lines: readonly string[], index: number, ctx: ManagerContext): number {
  const line = lines[index] ?? '';
  if (PNPM_RUN_DIRECTORY.test(line) && PNPM_RUN_PACKAGE.test(lines[index + 1] ?? '')) {
    return spanThrough(lines, index, index + 2, PNPM_RUN_DETAIL);
  }
  if (PNPM_RUN_FAILED.test(line)) return spanThrough(lines, index, index + 1, PNPM_RUN_DETAIL);
  const head = /^(\S+ \S+): (.*)$/.exec(line);
  const pnpm =
    PNPM_FAILED.test(line) ||
    PNPM_SCOPE.test(line) ||
    PNPM_RECURSIVE_ECHO.test(line) ||
    (head !== null && ctx.heads.has(head[1] ?? '') && PNPM_RECURSIVE_STATUS.test(head[2] ?? ''));
  return pnpm ? 1 : 0;
}

/** How many lines from `index` on npm, yarn or bun printed, or pnpm's echo: 0 when the line is the script's. */
function managerSpan(lines: readonly string[], index: number, ctx: ManagerContext): number {
  const line = lines[index] ?? '';
  if (YARN_FAILED.test(line)) return spanThrough(lines, index, index + 1, YARN_WORKSPACE_FAILED);
  if (NPM_LIFECYCLE_FAILED.test(line)) return spanThrough(lines, index, index + 1, NPM_ERROR);
  const manager =
    (ctx.echoes && COMMAND_ECHO.test(line)) ||
    BUN_FILTER_EXITED.test(line) ||
    BUN_FAILED.test(line) ||
    YARN_HEADER.test(line) ||
    YARN_LINK.test(line) ||
    YARN_FOREACH_FAILED.test(line) ||
    (ctx.yarn && (YARN_WARNING.test(line) || YARN_DONE.test(line))) ||
    (ctx.yarnWorkspaces && YARN_WORKSPACES_PACKAGE.test(line));
  return manager ? 1 : 0;
}

/**
 * The lines a script printed, without the lines npm, pnpm, yarn or bun printed around it, also for
 * a workspace, filtered, recursive, chained or nested run. Each manager line is read by its shape
 * wherever it stands on its stream; a pnpm note counts as pnpm's only under another pnpm line, and
 * the `$ <command>` echo only when a manager that prints it ran or a signal ended the run. The
 * `<package> <script>: ` head of `pnpm -r` and `bun --filter` is cut from the script's lines.
 */
function scriptLines(stdout: string, stderr: string, run: { signaled: boolean }): string[] {
  const streams = [withoutRunBanners(stdout), nonEmptyLines(stderr)];
  const all = streams.flat();
  const yarn = all.some((line) => YARN_HEADER.test(line) || YARN_LINK.test(line));
  const ctx: ManagerContext = {
    echoes:
      run.signaled || yarn || all.some((line) => PNPM_11_LABEL.test(line) || BUN_FAILED.test(line)),
    yarn,
    yarnWorkspaces: all.some((line) => /^yarn workspaces v\d/.test(line)),
    heads: new Set(
      all.flatMap(
        (line) => (PNPM_RECURSIVE_ECHO.exec(line) ?? BUN_FILTER_EXITED.exec(line))?.[1] ?? [],
      ),
    ),
  };
  return streams.flatMap((lines) => {
    const own: string[] = [];
    let underPnpm = false;
    for (let index = 0; index < lines.length; ) {
      const line = lines[index] ?? '';
      const pnpm: number =
        pnpmSpan(lines, index, ctx) || (underPnpm && PNPM_NOTE.test(line) ? 1 : 0);
      const span = pnpm || managerSpan(lines, index, ctx);
      underPnpm = pnpm > 0;
      if (span > 0) {
        index += span;
        continue;
      }
      const head = /^(\S+ \S+): /.exec(line);
      own.push(head !== null && ctx.heads.has(head[1] ?? '') ? line.slice(head[0].length) : line);
      index++;
    }
    return own;
  });
}

/** A stack frame row: `at fn (file:1:2)`, vitest's `❯ file:1:2`, jest's `→ file:1:2`. */
const STACK_FRAME = /^(?:at |❯ |→ )/;

const TOKEN_PATTERNS = [
  String.raw`::[\w.:[\]-]+`,
  String.raw`\(\d+,\d+\)`,
  String.raw`:\d+(?::\d+)?`,
].map((suffix) => new RegExp(`${FAILURE_KEY_PATH}${suffix}`));

/** A warning severity right after the position: `: warning:`, `: DeprecationWarning:`. */
const WARNING_SEVERITY = /^[^\s(:]+(?:\(\d+,\d+\)|:\d+(?::\d+)?)\s*:?\s*\w*warning\b/i;

function tokenOf(line: string): string | undefined {
  for (const pattern of TOKEN_PATTERNS) {
    const match = pattern.exec(line);
    if (match !== null) {
      const token = normalizeProjectRelativePath(match[0]);
      return isTestNodeKey(token) ? token : `${token}${line.slice(match.index + match[0].length)}`;
    }
  }
  return undefined;
}

/**
 * The failure keys of a command's output: diagnostic lines from their path token onward, else its
 * non-empty lines. `diagnostics` is false when the keys are those raw lines. Such a key can be
 * runner output (an `npm` script banner, a `make` error summary) that names no failure.
 * A check-mark row, a test node id without FAILED or ERROR, a warning-severity row and a line of
 * Node's TAP stream are not failure keys; the severity is read where the tool prints it, never
 * from the message text.
 */
export function extractFailureKeys(rawOutput: string): { keys: string[]; diagnostics: boolean } {
  const lines = readNodeTap(rawOutput)
    .rest.split('\n')
    .map((line) => line.trim().replace(/\s*━+$/, ''))
    .filter((line) => line.length > 0);
  const tokens: string[] = [];
  for (const line of lines) {
    if (STACK_FRAME.test(line) || /^[✓√]|^.+:\d+: in \S+/.test(line) || /^warning\b/i.test(line))
      continue;
    const token = tokenOf(line);
    if (token === undefined) continue;
    if (isTestNodeKey(token) ? !/\b(?:FAILED|ERROR)\b/.test(line) : WARNING_SEVERITY.test(token)) {
      continue;
    }
    tokens.push(token);
  }
  return tokens.length > 0
    ? { keys: [...new Set(tokens)], diagnostics: true }
    : { keys: [...new Set(lines)], diagnostics: false };
}
