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

export function parseFailingTests(output: string): FailingTest[] {
  const failures: FailingTest[] = [];
  let pending: { test: FailingTest; skipSeparator: boolean }[] = [];
  let jestFile = '';
  const lines = stripVTControlCharacters(output).split('\n');
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
