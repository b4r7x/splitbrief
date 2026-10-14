import { stripVTControlCharacters } from 'node:util';

export type FailingTest = { file: string; name: string; message: string };

const PATTERNS = {
  vitest: /^FAIL\s+(?:\|[^|]+\|\s+|\S+\s{2,})?(\S+)(?:\s*>\s*(.+)|\s+\[.*\])$/,
  jestFile: /^FAIL\s+(\S+)(?:\s+\(\d+(?:\.\d+)? m?s\))?$/,
  jestTest: /^●\s+(.+)$/,
  pytest: /^FAILED (.+?)::(.+?)(?: - (.*))?$/,
  go: /^--- FAIL: (.+?) \([^)]+\)$/,
  cargo: /^test (.+?) \.\.\. FAILED$/,
};

export function failingTestKey(test: Pick<FailingTest, 'file' | 'name'>): string {
  return test.file === '' ? test.name : test.name === '' ? test.file : `${test.file}::${test.name}`;
}

export function failingTestLabel(test: Pick<FailingTest, 'file' | 'name'>): string {
  return [test.file, test.name].filter(Boolean).join(' > ');
}

const NODE_TAP = {
  version: /^TAP version \d+$/,
  point: /^( *)(not )?ok \d+(?: - (.*))?$/,
  subtest: /^( *)# Subtest: (.*)$/,
  structure: /^\s*(?:#|\d+\.\.\d+$)/,
  field: /^(\w+): (.*)$/,
  todo: / # TODO(?: .*)?$/,
  errorComment: /^# (\w*Error\b.*)$/,
};

type TapFailure = {
  test: FailingTest;
  wrapper: boolean;
  cancelled: boolean;
  children: TapFailure[];
};

/** A name as Node's TAP reporter escapes it: `\#` for `#`, `\\` for `\`. */
function unescapeTapName(name: string): string {
  return name.replace(/\\([\\#])/g, '$1');
}

/** A string value as Node's TAP reporter prints it: quoted like a JS literal, `\` escaping. */
function tapString(value: string): string {
  return value.replace(/^(['"`])(.*)\1$/, '$2').replace(/\\(['"`\\])/g, '$1');
}

/**
 * Node's built-in test runner TAP stream, from its `TAP version` line: its failing tests, and the
 * output lines that are not part of the stream. A failing test is named by its `# Subtest:`
 * ancestors joined like vitest, its file is the path of its `location:` line, and its message is
 * the first line of its `error:`. A test file whose process failed outside its tests (its block
 * records the `exitCode`) is a failure named by its file alone; its message is the first error
 * line Node printed as a `#` comment since the previous test point. A parent that failed only
 * because a subtest failed and a red `# TODO` test are not failing tests. A cancelled test fails
 * only when it has no failed subtest and no ancestor failed for its own reason (a hook, a
 * timeout), so one failure that cancels N tests counts once. Test points, their YAML
 * blocks and the `#` comment lines belong to the stream, so a stack or location line in them
 * never reaches `rest`.
 */
export function readNodeTap(output: string): { failures: FailingTest[]; rest: string } {
  const points: TapFailure[] = [];
  const rest: string[] = [];
  const ancestors: string[] = [];
  const failedAt: TapFailure[][] = [];
  let stream = false;
  let point:
    | { indent: string; failed?: TapFailure | undefined; said?: string | undefined }
    | undefined;
  let block: typeof point;
  let errorLines = false;
  let said: string | undefined;
  for (const raw of output.split('\n')) {
    const line = raw.trimEnd();
    if (!stream) {
      stream = NODE_TAP.version.test(line);
      if (!stream) rest.push(raw);
      continue;
    }
    if (block !== undefined) {
      if (line === `${block.indent}...`) {
        block = undefined;
        continue;
      }
      const failed = block.failed;
      if (failed === undefined) continue;
      if (errorLines && line.startsWith(`${block.indent} `)) {
        if (failed.test.message === '' && line.trim() !== '') failed.test.message = line.trim();
        continue;
      }
      errorLines = false;
      const field = NODE_TAP.field.exec(line.slice(block.indent.length));
      if (field === null) continue;
      const [, name, value = ''] = field;
      if (name === 'location') {
        failed.test.file = /^(.*):\d+:\d+$/.exec(tapString(value))?.[1] ?? '';
      } else if (name === 'exitCode') {
        failed.test.name = '';
        failed.test.message = block.said ?? '';
      } else if (name === 'failureType') {
        failed.wrapper = value === "'subtestsFailed'";
        failed.cancelled = value === "'cancelledByParent'";
      } else if (name === 'error') {
        errorLines = value.startsWith('|');
        if (!errorLines && failed.test.message === '') failed.test.message = tapString(value);
      }
      continue;
    }
    const opensBlock = point !== undefined && line === `${point.indent}---`;
    block = opensBlock ? point : undefined;
    point = undefined;
    if (opensBlock) continue;
    const subtest = NODE_TAP.subtest.exec(line);
    if (subtest !== null) {
      const depth = (subtest[1] ?? '').length / 4;
      ancestors.length = depth;
      ancestors[depth] = unescapeTapName(subtest[2] ?? '');
      continue;
    }
    const tap = NODE_TAP.point.exec(line);
    if (tap !== null) {
      const [, indent = '', notOk, description = ''] = tap;
      const depth = indent.length / 4;
      const children = failedAt[depth + 1] ?? [];
      failedAt.length = depth + 1;
      const failed =
        notOk === undefined || NODE_TAP.todo.test(description)
          ? undefined
          : {
              test: {
                file: '',
                name: [...ancestors.slice(0, depth), unescapeTapName(description)].join(' > '),
                message: '',
              },
              wrapper: false,
              cancelled: false,
              children,
            };
      if (failed !== undefined) {
        points.push(failed);
        failedAt[depth] = [...(failedAt[depth] ?? []), failed];
      }
      point = { indent: `${indent}  `, failed, said };
      said = undefined;
      continue;
    }
    said ??= NODE_TAP.errorComment.exec(line)?.[1];
    if (!NODE_TAP.structure.test(line)) rest.push(raw);
  }
  const kept = new Set<TapFailure>();
  const keep = (failure: TapFailure, underOwnFailure: boolean): void => {
    const counts = failure.cancelled
      ? !underOwnFailure && failure.children.length === 0
      : !failure.wrapper;
    if (counts) kept.add(failure);
    const own = !failure.wrapper && !failure.cancelled;
    for (const child of failure.children) keep(child, underOwnFailure || own);
  };
  const subtests = new Set(points.flatMap(({ children }) => children));
  for (const failure of points) if (!subtests.has(failure)) keep(failure, false);
  return {
    failures: points.filter((failure) => kept.has(failure)).map(({ test }) => test),
    rest: rest.join('\n'),
  };
}

export function parseFailingTests(output: string): FailingTest[] {
  const tap = readNodeTap(stripVTControlCharacters(output));
  const failures: FailingTest[] = [...tap.failures];
  let pending: { test: FailingTest; skipSeparator: boolean }[] = [];
  let jestFile = '';
  const lines = tap.rest.split('\n');
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    const file = PATTERNS.jestFile.exec(line);
    if (file !== null) {
      jestFile = file[1] ?? '';
      pending = [];
      continue;
    }
    const vitest = PATTERNS.vitest.exec(line);
    if (line.startsWith('FAIL') || /^(?:stdout|stderr)\s*\|/.test(line)) {
      jestFile = '';
      if (vitest === null) pending = [];
    }
    const jest = jestFile === '' ? null : PATTERNS.jestTest.exec(line);
    const go = PATTERNS.go.exec(line);
    if (vitest !== null || jest !== null || go !== null) {
      const failure = {
        file: vitest?.[1] ?? (jest === null ? '' : jestFile),
        name:
          vitest?.[2]?.split(/\s*>\s*/).join(' > ') ??
          jest?.[1]?.split(/\s*›\s*/).join(' > ') ??
          go?.[1] ??
          '',
        message: '',
      };
      failures.push(failure);
      pending.push({ test: failure, skipSeparator: vitest !== null });
      continue;
    }
    const pytest = PATTERNS.pytest.exec(line);
    const cargo = PATTERNS.cargo.exec(line);
    if (pytest !== null || cargo !== null) {
      failures.push({
        file: pytest?.[1] ?? '',
        name: pytest?.[2] ?? cargo?.[1] ?? '',
        message: pytest?.[3] ?? '',
      });
      pending = [];
      continue;
    }
    if (line === '') {
      let nextIndex = index + 1;
      while (lines[nextIndex]?.trim() === '') nextIndex++;
      const next = lines[nextIndex];
      if (next === undefined || (!PATTERNS.jestTest.test(next.trim()) && !/^\s{4}/.test(next))) {
        jestFile = '';
      }
      continue;
    }
    pending = pending.filter(({ test, skipSeparator }) => {
      if (skipSeparator && line.startsWith('⎯')) return true;
      test.message = line;
      return false;
    });
  }
  const seen = new Set<string>();
  return failures.filter(({ file, name }) => {
    const key = JSON.stringify([file, name]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
