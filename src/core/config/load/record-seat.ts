import YAML from 'yaml';
import { fromYaml, toYaml } from './transform.js';
import { readConfigDocument, type ConfigDocumentEdit } from './document.js';
import { transactConfigDocument } from './io.js';
import type { RunnerConfig } from '../accessors/runner-config.js';
import type { ImplementerProfileConfig } from '../../schemas/implementer-config.js';
import type { CrewSeatId } from '../../crew/identity.js';
import { narrowRecord } from '../../../utils/type-guards.js';

/** The one seat a switch writes: the block it names, or the build profile that failed. */
export type SeatOfRecord = Readonly<{ seat: CrewSeatId; profile?: string | undefined }>;

/** The runner block a seat switch writes; a build profile carries its own metadata. */
export type SeatRunnerValue = RunnerConfig | ImplementerProfileConfig;

function valueAt(document: Record<string, unknown>, camel: readonly string[]): unknown {
  let node: unknown = document;
  for (const key of camel) {
    const current = narrowRecord(node);
    if (current === null) return undefined;
    node = current[key];
  }
  return node;
}

function blockAddress(document: Record<string, unknown>, seat: SeatOfRecord): readonly string[] {
  if (seat.seat === 'plan') return ['planner'];
  if (seat.seat === 'review') return ['reviewer'];
  const profile = seat.profile;
  if (
    profile !== undefined &&
    valueAt(document, ['implementerProfiles', 'profiles', profile]) !== undefined
  ) {
    return ['implementer_profiles', 'profiles', profile];
  }
  return ['implementer'];
}

/**
 * Writes one seat into `config.yaml` against the revision the halt read: the named
 * block only — `planner`, `implementer`, the failing implementer profile or
 * `reviewer` — so every other seat and the file's own comments stay byte for byte.
 * A revision the file no longer carries is a conflict and writes nothing; the
 * block carries exactly the runner's fallback. The caller resolves the recovery only on
 * `saved`.
 */
export async function recordSeatOfRecord(
  projectDir: string,
  seat: SeatOfRecord,
  runner: SeatRunnerValue,
  expectedRevision: string,
): Promise<'saved' | 'conflict'> {
  const snapshot = readConfigDocument(projectDir);
  if (snapshot.revision === null || snapshot.revision.rawSha256 !== expectedRevision) {
    return 'conflict';
  }
  const document = fromYaml(YAML.parse(snapshot.rawYaml));
  const address = blockAddress(document, seat);
  const edit: ConfigDocumentEdit = {
    path: address,
    value: toYaml(runner),
  };
  const result = await transactConfigDocument(projectDir, snapshot.revision, [edit]);
  return result.kind === 'saved' ? 'saved' : 'conflict';
}
