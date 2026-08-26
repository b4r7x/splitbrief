import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '../../../utils/sha256.js';
import { rejectSymlinkTarget } from '../../../lib/fs.js';
import { assertExistingPathConfined } from '../../../lib/path-confinement.js';
import { SPLITBRIEF_DIR, SESSIONS_DIR, sessionDir } from '../../paths.js';
import type { SessionRef } from '../../types/session-ref.js';
import { legacyQualityReportSchema, type LegacyQualityReport } from './legacy-state.js';

export type MigrationArtifacts = {
  readonly briefBytes: Buffer | null;
  readonly reportBytes: Buffer | null;
  readonly briefHash: string | null;
  readonly reportHash: string | null;
  readonly report: LegacyQualityReport | null;
  readonly invalidArtifact: 'tasks.md' | 'brief-quality.json' | null;
};

function readArtifact(ref: SessionRef, name: 'tasks.md' | 'brief-quality.json'): Buffer | null {
  const dir = sessionDir(ref.projectDir, ref.sessionId);
  const path = join(dir, name);
  try {
    if (!existsSync(path)) return null;
    rejectSymlinkTarget(path);
    assertExistingPathConfined(
      `${SPLITBRIEF_DIR}/${SESSIONS_DIR}/${ref.sessionId}/${name}`,
      ref.projectDir,
    );
    const stat = lstatSync(path);
    if (!stat.isFile()) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}

export function readMigrationArtifacts(ref: SessionRef): MigrationArtifacts {
  const briefBytes = readArtifact(ref, 'tasks.md');
  if (briefBytes === null) {
    return {
      briefBytes: null,
      reportBytes: null,
      briefHash: null,
      reportHash: null,
      report: null,
      invalidArtifact: 'tasks.md',
    };
  }

  const reportBytes = readArtifact(ref, 'brief-quality.json');
  if (reportBytes === null) {
    return {
      briefBytes,
      reportBytes: null,
      briefHash: sha256Hex(briefBytes),
      reportHash: null,
      report: null,
      invalidArtifact: 'brief-quality.json',
    };
  }

  let reportValue: unknown;
  try {
    reportValue = JSON.parse(reportBytes.toString('utf8'));
  } catch {
    return {
      briefBytes,
      reportBytes,
      briefHash: sha256Hex(briefBytes),
      reportHash: sha256Hex(reportBytes),
      report: null,
      invalidArtifact: 'brief-quality.json',
    };
  }
  const parsed = legacyQualityReportSchema.safeParse(reportValue);
  if (!parsed.success) {
    return {
      briefBytes,
      reportBytes,
      briefHash: sha256Hex(briefBytes),
      reportHash: sha256Hex(reportBytes),
      report: null,
      invalidArtifact: 'brief-quality.json',
    };
  }
  const briefHash = sha256Hex(briefBytes);
  if (parsed.data.briefHash !== undefined && parsed.data.briefHash !== briefHash) {
    return {
      briefBytes,
      reportBytes,
      briefHash,
      reportHash: sha256Hex(reportBytes),
      report: null,
      invalidArtifact: 'brief-quality.json',
    };
  }
  return {
    briefBytes,
    reportBytes,
    briefHash,
    reportHash: sha256Hex(reportBytes),
    report: parsed.data,
    invalidArtifact: null,
  };
}
