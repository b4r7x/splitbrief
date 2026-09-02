import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export const T065_RULES = [
  'direct-state',
  'raw-state-writer',
  'reducer-import',
  'briefs-ready',
  'quality-gate',
  'continuation',
  'recovery-provider',
  'recovery-marker',
  'adapters',
  'hydration',
] as const;

export type T065Rule = (typeof T065_RULES)[number];

export type T065Finding = Readonly<{
  rule: T065Rule;
  path: string;
  line: number;
  message: string;
}>;

type T065SourceFile = Readonly<{
  absolutePath: string;
  displayPath: string;
  relativePath: string;
  text: string;
  lines: readonly string[];
}>;

const T065_OWNER_PATHS = [
  'src/app/prepare-resume.ts',
  'src/cli/commands/continue/command.ts',
  'src/cli/commands/resume.ts',
  'src/cli/headless.ts',
  'src/cli/rpc/run/host.ts',
  'src/engine/ipc/workflow-loop/run.ts',
  'src/engine/ipc/workflow-loop/recovery.ts',
  'src/engine/orchestrator/planning/failure.ts',
  'src/engine/orchestrator/recovery/driver.ts',
  'src/engine/orchestrator/run/rewind-authority.ts',
  'src/engine/orchestrator/transcript/rebuild.ts',
  'src/features/workflow/hooks/use-runner.ts',
  'src/features/workflow/hooks/workflow-screen/resume.ts',
  'src/stores/navigation/session-select.ts',
] as const;

const T065_STRICT_V4_PATHS = [
  'src/cli/commands/status.ts',
  'src/core/sessions/io.ts',
  'src/core/state/persistence.ts',
  'src/engine/handoff/write.ts',
  'src/engine/ipc/server-entry.ts',
  'src/engine/orchestrator/explain/artifacts.ts',
  'src/engine/orchestrator/queue/native-injection.ts',
  'src/engine/orchestrator/state-ops.ts',
  'src/engine/orchestrator/task/retry.ts',
  'src/engine/orchestrator/transcript/compaction.ts',
] as const;

const T065_PERSISTENCE_PATH = 'src/core/state/persistence.ts';
const T065_STATE_OPS_PATH = 'src/engine/orchestrator/state-ops.ts';
const T065_CONTROLLER_PATH = 'src/engine/orchestrator/planning/brief-recovery-controller.ts';
const T065_REDUCER_PATH = 'src/engine/orchestrator/planning/brief-recovery.ts';
const T065_QUALITY_GATE_PATH = 'src/engine/orchestrator/planning/brief-quality-gate.ts';
const T065_CONTINUATION_PATH = 'src/engine/orchestrator/continuation.ts';
const T065_REGEN_PATH = 'src/engine/orchestrator/planning/regen.ts';
const T065_PROVIDER_PATH = 'src/engine/orchestrator/planning/brief-recovery-provider.ts';
const T065_PLANNER_REVIEW_PATH = 'src/engine/orchestrator/planner-review.ts';
const T065_HARNESS_PATH = 'src/engine/runners/cli-tools/contract-harness.ts';
const T065_HARNESS_EFFECTS_PATH = 'src/engine/runners/cli-tools/contract-harness-effects.ts';

function normalizePath(value: string): string {
  return value.split(sep).join('/');
}

function sourcePathMatches(file: T065SourceFile, path: string): boolean {
  const normalized = normalizePath(path);
  const expected = normalized.startsWith('src/') ? normalized.slice('src/'.length) : normalized;
  return file.relativePath === expected || file.relativePath.endsWith(`/${expected}`);
}

function sourceFiles(root: string): T065SourceFile[] {
  const absoluteRoot = resolve(root);
  if (!existsSync(absoluteRoot) || !statSync(absoluteRoot).isDirectory()) {
    throw new Error(`T-065 source root does not exist: ${root}`);
  }

  const files: T065SourceFile[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git') visit(absolutePath);
        continue;
      }
      if (!entry.isFile() || !/\.tsx?$/u.test(entry.name) || /\.test\.tsx?$/u.test(entry.name)) {
        continue;
      }
      const relativePath = normalizePath(relative(absoluteRoot, absolutePath));
      const displayPath = normalizePath(relative(process.cwd(), absolutePath));
      const text = readFileSync(absolutePath, 'utf8');
      files.push({
        absolutePath,
        displayPath: displayPath || normalizePath(absolutePath),
        relativePath,
        text,
        lines: text.split(/\r?\n/u),
      });
    }
  };
  visit(absoluteRoot);
  return files.sort((left, right) => left.displayPath.localeCompare(right.displayPath));
}

function t065PathAllowed(file: T065SourceFile, paths: readonly string[]): boolean {
  return paths.some((path) => sourcePathMatches(file, path));
}

function lineMatches(lines: readonly string[], pattern: RegExp): number[] {
  const matches: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (pattern.test(line)) matches.push(index + 1);
  }
  return matches;
}

function scanT065Rule(files: readonly T065SourceFile[], rule: T065Rule): T065Finding[] {
  const findings: T065Finding[] = [];
  const add = (file: T065SourceFile, line: number, message: string): void => {
    findings.push({ rule, path: file.displayPath, line, message });
  };

  for (const file of files) {
    const allowedPersistence = sourcePathMatches(file, T065_PERSISTENCE_PATH);
    const allowedStateOps = sourcePathMatches(file, T065_STATE_OPS_PATH);
    const isController = sourcePathMatches(file, T065_CONTROLLER_PATH);

    if (rule === 'direct-state') {
      if (allowedPersistence || allowedStateOps) continue;
      for (const line of lineMatches(
        file.lines,
        /(?:\bimport\b[^;]*\bsaveState\b|\bsaveState\s*\()/u,
      )) {
        add(file, line, 'direct saveState is only legal in state persistence or state-ops');
      }
    }

    if (rule === 'raw-state-writer') {
      if (allowedPersistence) continue;
      const hasStateReference = /\bSTATE_FILE\b|state\.json/u.test(file.text);
      const directStateWriterLine = lineMatches(
        file.lines,
        /(?:\bSTATE_FILE\b|state\.json).*\b(?:writeFileSync|writeFile|renameSync|rename|replaceSync|replace)\b|\b(?:writeFileSync|writeFile|renameSync|rename|replaceSync|replace)\b.*(?:\bSTATE_FILE\b|state\.json)/u,
      )[0];
      if (directStateWriterLine !== undefined) {
        add(
          file,
          directStateWriterLine,
          'raw state.json replacement is only legal in core state persistence',
        );
      } else if (hasStateReference && /\bconfinedAtomicWriteFileSync\b/u.test(file.text)) {
        const line = lineMatches(file.lines, /\bconfinedAtomicWriteFileSync\b/u)[0] ?? 1;
        add(file, line, 'raw state.json replacement is only legal in core state persistence');
      }
    }

    if (rule === 'reducer-import') {
      const planningSource = /(?:^|\/)engine\/orchestrator\/planning\//u.test(file.relativePath);
      if (isController || sourcePathMatches(file, T065_REDUCER_PATH)) continue;
      for (const line of lineMatches(
        file.lines,
        planningSource
          ? /\bfrom\s+['"][^'"]*(?:\/planning\/brief-recovery|\.\/brief-recovery)\.js['"]/u
          : /\bfrom\s+['"][^'"]+\/planning\/brief-recovery\.js['"]/u,
      )) {
        add(file, line, 'the pure recovery reducer may only be imported by its controller');
      }
    }

    if (rule === 'briefs-ready') {
      const allowed =
        sourcePathMatches(file, 'src/core/state/types.ts') ||
        sourcePathMatches(file, 'src/core/state/machine.ts') ||
        isController;
      if (allowed) continue;
      for (const line of lineMatches(file.lines, /\bBRIEFS_READY\b/u)) {
        add(
          file,
          line,
          'BRIEFS_READY may only be declared, interpreted, or emitted at its owner seam',
        );
      }
    }

    if (rule === 'quality-gate') {
      const qualityGate = sourcePathMatches(file, T065_QUALITY_GATE_PATH);
      if (qualityGate || isController) continue;
      for (const line of lineMatches(file.lines, /\brunBriefQualityGate\b/u)) {
        add(
          file,
          line,
          'runBriefQualityGate is controller-owned and cannot be called by an adapter',
        );
      }
    }

    if (rule === 'continuation') {
      const continuation = sourcePathMatches(file, T065_CONTINUATION_PATH);
      const regeneration = sourcePathMatches(file, T065_REGEN_PATH);
      if (!continuation) {
        for (const line of lineMatches(file.lines, /\bRecoveryContinuationMarker\b/u)) {
          add(file, line, 'RecoveryContinuationMarker has a single implementation');
        }
      }
      if (!continuation && !regeneration) {
        for (const line of lineMatches(file.lines, /\bnoAutomaticContinuation\s*:/u)) {
          add(
            file,
            line,
            'noAutomaticContinuation may only be implemented by the continuation seam',
          );
        }
      }
      const recoveryMarker = lineMatches(file.lines, /\bbriefRecovery\s*:\s*true\b/u);
      if (recoveryMarker.length > 0 && !continuation) {
        if (!regeneration) {
          add(
            file,
            recoveryMarker[0] ?? 1,
            'recovery continuation marker has a single implementation',
          );
        } else if (
          !/\bnoAutomaticContinuation\s*:\s*true\b/u.test(file.text) ||
          !/\boperationId\b/u.test(file.text)
        ) {
          add(
            file,
            recoveryMarker[0] ?? 1,
            'recovery continuation marker must carry operationId and noAutomaticContinuation',
          );
        }
      }
    }

    if (rule === 'recovery-provider') {
      const provider = sourcePathMatches(file, T065_PROVIDER_PATH);
      const plannerReview = sourcePathMatches(file, T065_PLANNER_REVIEW_PATH);
      // test-only conformance driver calling the production factory directly
      const harness =
        sourcePathMatches(file, T065_HARNESS_PATH) ||
        sourcePathMatches(file, T065_HARNESS_EFFECTS_PATH);
      if (!provider && !plannerReview && !harness) {
        for (const line of lineMatches(file.lines, /\bplanner\s*\.\s*review\s*\(/u)) {
          add(file, line, 'recovery planner.review calls must cross brief-recovery-provider.ts');
        }
      }
      if (plannerReview && !/createBriefRecoveryProvider|\.dispatch\s*\(/u.test(file.text)) {
        add(file, 1, 'planner-review.ts must delegate explicit recovery calls to the provider');
      }
    }

    if (rule === 'recovery-marker') {
      if (sourcePathMatches(file, T065_CONTINUATION_PATH)) continue;
      const recoveryMarker = lineMatches(file.lines, /\bbriefRecovery\s*:\s*true\b/u);
      if (recoveryMarker.length === 0) continue;
      if (
        !/\bnoAutomaticContinuation\s*:\s*true\b/u.test(file.text) ||
        !/\boperationId\b/u.test(file.text)
      ) {
        add(
          file,
          recoveryMarker[0] ?? 1,
          'recovery continuation requires noAutomaticContinuation and operationId',
        );
      }
      for (const line of lineMatches(
        file.lines,
        /\bonContinuationNeeded\b|\bplanner\s*\.\s*review\s*\(/u,
      )) {
        add(
          file,
          line,
          'recovery continuation cannot invoke a second review or continuation callback',
        );
      }
    }

    if (rule === 'adapters') {
      const adapter = /^(?:cli|engine\/ipc|features|stores)\//u.test(file.relativePath);
      if (!adapter) continue;
      for (const line of lineMatches(
        file.lines,
        /\b(?:runBriefQualityGate|reduceBriefRecovery|planner\s*\.\s*review)\b/u,
      )) {
        add(file, line, 'client adapters may only call the recovery controller/public projection');
      }
    }

    if (rule === 'hydration') {
      const owner = t065PathAllowed(file, T065_OWNER_PATHS);
      const strictV4 = t065PathAllowed(file, T065_STRICT_V4_PATHS);
      const directLoad = lineMatches(
        file.lines,
        /(?:\bloadState\s*\(|\.loadState\s*\(|\bimport\b[^;]*\bloadState\b)/u,
      );
      if (owner) {
        if (directLoad.length > 0) {
          add(file, directLoad[0] ?? 1, 'owner hydration cannot call loadState directly');
        }
        if (
          !/\bloadStateForResume\b|\bloadOwnerWorkflowState\b|\bhydrate(?:Resume|State)\b/u.test(
            file.text,
          )
        ) {
          add(file, 1, 'owner hydration must use or inject loadStateForResume');
        }
      } else if (directLoad.length > 0 && !strictV4) {
        add(
          file,
          directLoad[0] ?? 1,
          'loadState path is not classified as owner hydration or strict-v4 observation',
        );
      }
    }
  }

  return findings;
}

export function scanT065Invariants(
  root = 'src',
  rule: T065Rule | 'all' = 'all',
): readonly T065Finding[] {
  const files = sourceFiles(root);
  const rules = rule === 'all' ? T065_RULES : [rule];
  const findings = rules.flatMap((currentRule) => scanT065Rule(files, currentRule));
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.rule}|${finding.path}|${finding.line}|${finding.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
