import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getInvariantGates,
  runInvariantGates,
  scanT065Invariants,
  T065_RULES,
  type Gate,
} from './check-invariants.js';

function captureLog(): { lines: string[]; log: (line?: string) => void } {
  const lines: string[] = [];
  return { lines, log: (line) => line !== undefined && lines.push(line) };
}

describe('check-invariants', () => {
  it('fails closed when a gate command fails', () => {
    const gate: Gate = {
      id: 'broken',
      description: 'Broken gate',
      command: 'missing-tool',
      expected: 0,
    };
    const { lines, log } = captureLog();

    const failed = runInvariantGates(
      [gate],
      () => {
        throw new Error('missing-tool');
      },
      log,
    );

    expect(failed).toBe(1);
    expect(lines).toEqual([
      '  ✗ [broken] Broken gate: command failed: missing-tool (expected 0) FAIL',
    ]);
  });

  it('fails closed when a pipeline hides a broken command behind wc', () => {
    const gate: Gate = {
      id: 'pipeline',
      description: 'Broken pipeline',
      command: '__splitbrief_missing_command__ | wc -l',
      expected: 0,
    };
    const { lines, log } = captureLog();

    expect(
      execSync('bash -c "__splitbrief_missing_command__ | wc -l"', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim(),
    ).toBe('0');
    expect(runInvariantGates([gate], undefined, log)).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^ {2}✗ \[pipeline\] Broken pipeline: command failed: .+ \(expected 0\) FAIL$/u,
    );
  });

  it('fails closed when a silent pipeline stage exits nonzero before wc', () => {
    const gate: Gate = {
      id: 'silent-pipeline',
      description: 'Silent broken pipeline',
      command: 'false | wc -l',
      expected: 0,
    };
    const { lines, log } = captureLog();

    expect(
      execSync('bash -c "false | wc -l"', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim(),
    ).toBe('0');
    expect(runInvariantGates([gate], undefined, log)).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^ {2}✗ \[silent-pipeline\] Silent broken pipeline: command failed: .+ \(expected 0\) FAIL$/u,
    );
  });

  it('gate 18/19 pipeline shape fails closed when the wrapped tool crashes to stderr', () => {
    const crash = 'sh -c \'echo "boom: tool crashed" >&2; exit 2\'';
    const gate: Gate = {
      id: 'tool-crash',
      description: 'Tool crash via gate 18/19 shape',
      command: `{ ${crash} | rg . || true; } | wc -l`,
      expected: 0,
    };
    const { lines, log } = captureLog();

    expect(runInvariantGates([gate], undefined, log)).toBe(1);
    expect(lines).toEqual([
      '  ✗ [tool-crash] Tool crash via gate 18/19 shape: command failed: boom: tool crashed (expected 0) FAIL',
    ]);
  });

  it('gate 18/19 shape counts a clean matching run as PASS when injected', () => {
    const gate: Gate = {
      id: 'matching',
      description: 'Matching count',
      command: 'unused',
      expected: 0,
    };
    const { lines, log } = captureLog();

    expect(runInvariantGates([gate], () => '0', log)).toBe(0);
    expect(lines).toEqual(['  ✓ [matching] Matching count: 0 (expected 0) PASS']);
  });

  it('gate 18/19 shape still counts findings on a clean (non-crashing) tool run', () => {
    const findings = 'printf "finding-a\\nfinding-b\\n"';
    const gate: Gate = {
      id: 'findings',
      description: 'Findings counted',
      command: `{ ${findings} | rg . || true; } | wc -l`,
      expected: 0,
    };
    const { lines, log } = captureLog();

    expect(runInvariantGates([gate], undefined, log)).toBe(1);
    expect(lines).toEqual(['  ✗ [findings] Findings counted: 2 (expected 0) FAIL']);
  });

  it('fails closed when gate output is not numeric', () => {
    const gate: Gate = {
      id: 'nonnumeric',
      description: 'Nonnumeric gate',
      command: 'printf not-a-number',
      expected: 0,
    };
    const { lines, log } = captureLog();

    expect(runInvariantGates([gate], undefined, log)).toBe(1);
    expect(lines).toEqual([
      '  ✗ [nonnumeric] Nonnumeric gate: invalid output "not-a-number" (expected 0) FAIL',
    ]);
  });

  it('runs brand gate 27 through the fail-closed command runner', () => {
    const brandGates = getInvariantGates('27');
    const commands: string[] = [];
    const execCommand = (command: string): string => {
      commands.push(command);
      throw new Error('brand scan failed');
    };
    const { lines, log } = captureLog();

    expect(brandGates).toHaveLength(1);
    expect(runInvariantGates(brandGates, execCommand, log)).toBe(1);
    expect(commands).toEqual(brandGates.map((gate) => gate.command));
    expect(lines).toEqual([
      '  ✗ [27] Maintained tree uses only canonical SPLITBRIEF identity: command failed: brand scan failed (expected 0) FAIL',
    ]);
  });

  it('keeps the broad-cast allowlist synchronized with the documented type guard boundary', () => {
    const [gate] = getInvariantGates('17c');
    if (gate === undefined) throw new Error('gate 17c is not registered');

    expect(gate.command).toContain('utils/type-guards');
    expect(readFileSync('CLAUDE.md', 'utf8')).toContain('src/utils/type-guards.ts');
    expect(readFileSync('docs/INVARIANTS.md', 'utf8')).toContain('utils/type-guards');
  });

  it('registers architecture and transport gates 28 through 35', () => {
    const ids = ['28', '29', '30', '31', '32', '33', '34', '35'] as const;
    for (const id of ids) {
      expect(getInvariantGates(id)).toHaveLength(1);
    }
  });

  it('runs legacy CLI gate 28 through the fail-closed command runner', () => {
    const legacyGates = getInvariantGates('28');
    const commands: string[] = [];
    const execCommand = (command: string): string => {
      commands.push(command);
      throw new Error('rg failed');
    };
    const { lines, log } = captureLog();

    expect(runInvariantGates(legacyGates, execCommand, log)).toBe(1);
    expect(commands).toEqual(legacyGates.map((gate) => gate.command));
    expect(lines).toEqual([
      '  ✗ [28] Zero legacy CLI_TOOLS / cli-tools.ts / clampPromptForArgv: command failed: rg failed (expected 0) FAIL',
    ]);
  });

  it('passes architecture gates 28 through 35 on the maintained tree', () => {
    const architectureGates = [
      ...getInvariantGates('28'),
      ...getInvariantGates('29'),
      ...getInvariantGates('30'),
      ...getInvariantGates('31'),
      ...getInvariantGates('32'),
      ...getInvariantGates('33'),
      ...getInvariantGates('34'),
      ...getInvariantGates('35'),
    ];
    const { lines, log } = captureLog();

    expect(runInvariantGates(architectureGates, undefined, log)).toBe(0);
    expect(lines).toEqual(
      architectureGates.map((gate) => `  ✓ [${gate.id}] ${gate.description}: 0 (expected 0) PASS`),
    );
  });

  it('gate 33 detects a commercial metadata fetch retargeted at a synthetic tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'splitbrief-gate-33-'));
    try {
      mkdirSync(join(root, 'engine/providers'), { recursive: true });
      writeFileSync(
        join(root, 'engine/providers/pricing.ts'),
        'const pricing = await fetchJsonWithTimeout(PRICING_URL, 5_000);\n',
      );
      writeFileSync(join(root, 'engine/providers/terms.ts'), 'export const termsURL = TERMS;\n');
      const [gate] = getInvariantGates('33');
      if (gate === undefined) throw new Error('gate 33 is not registered');
      const { lines, log } = captureLog();

      expect(
        runInvariantGates(
          [{ ...gate, command: gate.command.replaceAll('src/', `${root}/`) }],
          undefined,
          log,
        ),
      ).toBe(1);
      expect(lines).toEqual([
        expect.stringContaining(
          '[33] No runtime commercial metadata URL fetch outside models.dev module: 2 (expected 0) FAIL',
        ),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('guards the settings surfaces that now host the seat rows in gate 31', () => {
    const [gate] = getInvariantGates('31');
    if (gate === undefined) throw new Error('gate 31 is not registered');

    expect(gate.command).toContain('src/features/settings');
    expect(gate.command).toContain('src/app/overlays/settings.tsx');
    expect(gate.command).not.toContain('src/app/overlays/crew.tsx');
    expect(readFileSync('docs/INVARIANTS.md', 'utf8')).toContain('src/app/overlays/settings.tsx');
  });

  it('passes the responsive-width and capability-direction gates 46 and 47 on the maintained tree', () => {
    const gates = [...getInvariantGates('46'), ...getInvariantGates('47')];
    expect(gates).toHaveLength(2);
    const { lines, log } = captureLog();

    expect(runInvariantGates(gates, undefined, log)).toBe(0);
    expect(lines).toEqual(
      gates.map((gate) => `  \u2713 [${gate.id}] ${gate.description}: 0 (expected 0) PASS`),
    );
  });

  it('gate 46 detects pinned widths retargeted at a synthetic tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'splitbrief-gate-46-'));
    try {
      for (const dir of [
        'app/overlays',
        'app/screens',
        'features/home',
        'features/runners',
        'features/start-preparation',
        'features/workflow/cost-drilldown',
        'components/overlays',
        'components/pickers',
      ]) {
        mkdirSync(join(root, dir), { recursive: true });
      }
      writeFileSync(join(root, 'app/screens/home.tsx'), 'export const Home = () => null;\n');
      writeFileSync(join(root, 'app/screens/setup.tsx'), 'export const Setup = () => null;\n');
      writeFileSync(
        join(root, 'app/overlays/pinned.tsx'),
        'export const P = <Box maxWidth={64} />;\n',
      );
      writeFileSync(join(root, 'features/home/layout.ts'), 'export const w = isSmall ? 60 : 84;\n');
      writeFileSync(join(root, 'registry.ts'), 'export const locators = [];\n');
      const [gate] = getInvariantGates('46');
      if (gate === undefined) throw new Error('gate 46 is not registered');
      const { lines, log } = captureLog();
      const retargeted = gate.command
        .replaceAll('src/', `${root}/`)
        .replaceAll('" src ', `" ${root} `)
        .replaceAll('testing/visual/locators/registry.ts', join(root, 'registry.ts'));

      expect(runInvariantGates([{ ...gate, command: retargeted }], undefined, log)).toBe(1);
      // one `maxWidth=` prop plus one width-carrying `isSmall` branch
      expect(lines).toEqual([
        expect.stringContaining('[46] Pinned overlay widths are gone: 2 (expected 0) FAIL'),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('gate 47 detects a UI import of engine capability inference in a synthetic tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'splitbrief-gate-47-'));
    try {
      for (const dir of ['features/runners', 'app', 'components', 'core']) {
        mkdirSync(join(root, dir), { recursive: true });
      }
      writeFileSync(
        join(root, 'features/runners/row.ts'),
        "import { infer } from '../../engine/providers/capability-inference.js';\n",
      );
      const [gate] = getInvariantGates('47');
      if (gate === undefined) throw new Error('gate 47 is not registered');
      const { lines, log } = captureLog();

      expect(
        runInvariantGates(
          [{ ...gate, command: gate.command.replaceAll('src/', `${root}/`) }],
          undefined,
          log,
        ),
      ).toBe(1);
      expect(lines).toEqual([
        expect.stringContaining(
          '[47] Capability inference is imported from core, never from engine: 1 (expected 0) FAIL',
        ),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('registers the path-aware T-065 controller-boundary gates', () => {
    expect(T065_RULES).toHaveLength(10);
    for (const id of ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45']) {
      expect(getInvariantGates(id)).toHaveLength(1);
    }
  });

  it('reports the exact source path and line for a direct state-writer violation', () => {
    const root = mkdtempSync(join(tmpdir(), 'splitbrief-t065-'));
    try {
      const path = join(root, 'cli', 'bad.ts');
      mkdirSync(join(root, 'cli'), { recursive: true });
      writeFileSync(
        path,
        "import { saveState } from '../core/state/persistence.js';\nsaveState(ref, state);\n",
      );

      const findings = scanT065Invariants(root, 'direct-state');

      expect(findings).toHaveLength(2);
      expect(findings[0]).toEqual(
        expect.objectContaining({
          rule: 'direct-state',
          path: expect.stringContaining('cli/bad.ts'),
          line: 1,
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails a T-065 gate on a synthetic path instead of hiding its diagnostic', () => {
    const root = mkdtempSync(join(tmpdir(), 'splitbrief-t065-gate-'));
    try {
      mkdirSync(join(root, 'consumer'), { recursive: true });
      writeFileSync(
        join(root, 'consumer', 'bad.ts'),
        "import { runBriefQualityGate } from '../engine/orchestrator/planning/brief-quality-gate.js';\nrunBriefQualityGate({ tasks: [] });\n",
      );
      const [gate] = getInvariantGates('40');
      if (gate === undefined) throw new Error('T-065 quality gate is not registered');
      const { lines, log } = captureLog();

      expect(
        runInvariantGates(
          [{ ...gate, command: gate.command.replace('src/', `${root}/`) }],
          undefined,
          log,
        ),
      ).toBe(1);
      expect(lines[0]).toContain('[40]');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('classifies owner hydration and rejects an unclassified loadState path', () => {
    const root = mkdtempSync(join(tmpdir(), 'splitbrief-t065-hydration-'));
    try {
      mkdirSync(join(root, 'app'), { recursive: true });
      mkdirSync(join(root, 'misc'), { recursive: true });
      writeFileSync(
        join(root, 'app', 'prepare-resume.ts'),
        "import { loadState } from '../core/state/persistence.js';\nexport const resume = () => loadState(ref);\n",
      );
      writeFileSync(
        join(root, 'misc', 'reader.ts'),
        "import { loadState } from '../core/state/persistence.js';\nexport const read = () => loadState(ref);\n",
      );

      const findings = scanT065Invariants(root, 'hydration');

      expect(findings.map((finding) => finding.path)).toEqual([
        expect.stringContaining('app/prepare-resume.ts'),
        expect.stringContaining('app/prepare-resume.ts'),
        expect.stringContaining('misc/reader.ts'),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a recovery marker that can re-enter review without the guard fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'splitbrief-t065-marker-'));
    try {
      const path = join(root, 'engine', 'bad.ts');
      mkdirSync(join(root, 'engine'), { recursive: true });
      writeFileSync(
        path,
        "const marker = { briefRecovery: true, operationId: 'op-1' };\nplanner.review(prompt);\n",
      );

      const findings = scanT065Invariants(root, 'recovery-marker');

      expect(findings).toEqual([
        expect.objectContaining({ path: expect.stringContaining('engine/bad.ts'), line: 1 }),
        expect.objectContaining({ path: expect.stringContaining('engine/bad.ts'), line: 2 }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the T-065 source root is missing', () => {
    expect(() => scanT065Invariants('/tmp/splitbrief-t065-does-not-exist')).toThrow(
      'T-065 source root does not exist',
    );
  });
});
