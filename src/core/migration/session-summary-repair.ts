import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { isInsideRoot } from '../../lib/path-confinement.js';
import { isENOENT } from '../../lib/process/errors.js';
import { sessionsRoot, SUMMARY_FILE, validateSessionId } from '../paths.js';
import { saveSummary } from '../sessions/io.js';
import { parsePersistedSession } from '../sessions/summary-parser.js';

export interface SessionSummaryRepairResult {
  checked: number;
  repaired: number;
  skippedInvalid: number;
  skippedUnreadable: number;
  warnings: string[];
}

const EMPTY_REPAIR_RESULT: SessionSummaryRepairResult = {
  checked: 0,
  repaired: 0,
  skippedInvalid: 0,
  skippedUnreadable: 0,
  warnings: [],
};

function isValidSessionId(sessionId: string): boolean {
  try {
    validateSessionId(sessionId);
    return true;
  } catch {
    return false;
  }
}

function isRegularFile(path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isFile() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function validateSessionsRoot(
  projectDir: string,
): { ok: true; root: string } | { ok: false; warnings: string[] } {
  const root = sessionsRoot(projectDir);
  if (!existsSync(root)) return { ok: false, warnings: [] };

  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(root);
  } catch {
    return { ok: false, warnings: [] };
  }

  if (st.isSymbolicLink()) {
    return {
      ok: false,
      warnings: ['Sessions root is a symlink; skipping summary repair.'],
    };
  }

  if (!st.isDirectory()) {
    return {
      ok: false,
      warnings: ['Sessions root is not a directory; skipping summary repair.'],
    };
  }

  try {
    const realProject = realpathSync(projectDir);
    const realRoot = realpathSync(root);
    if (!isInsideRoot(realProject, realRoot)) {
      return {
        ok: false,
        warnings: ['Sessions root resolves outside project directory; skipping summary repair.'],
      };
    }
  } catch {
    return {
      ok: false,
      warnings: ['Sessions root could not be resolved safely; skipping summary repair.'],
    };
  }

  return { ok: true, root };
}

export function repairSessionSummaries(projectDir: string): SessionSummaryRepairResult {
  const validated = validateSessionsRoot(projectDir);
  if (!validated.ok) {
    return { ...EMPTY_REPAIR_RESULT, warnings: validated.warnings };
  }

  const root = validated.root;
  const result: SessionSummaryRepairResult = { ...EMPTY_REPAIR_RESULT, warnings: [] };
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isValidSessionId(entry.name)) continue;

    const summaryPath = join(root, entry.name, SUMMARY_FILE);
    if (!existsSync(summaryPath)) continue;
    if (!isRegularFile(summaryPath)) {
      result.skippedUnreadable++;
      continue;
    }

    result.checked++;

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(summaryPath, 'utf-8'));
    } catch (err) {
      if (!isENOENT(err)) result.skippedUnreadable++;
      continue;
    }

    const parsed = parsePersistedSession(raw);
    if (parsed.status === 'invalid') {
      result.skippedInvalid++;
      continue;
    }
    if (!parsed.migrated) continue;

    const repairedSession = { ...parsed.session, id: entry.name };
    saveSummary({ projectDir, sessionId: entry.name }, repairedSession);
    result.repaired++;
  }

  return result;
}
