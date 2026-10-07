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

type BlockAddress = Readonly<{ path: readonly string[]; camel: readonly string[] }>;

function valueAt(document: Record<string, unknown>, camel: readonly string[]): unknown {
  let node: unknown = document;
  for (const key of camel) {
    const current = narrowRecord(node);
    if (current === null) return undefined;
    node = current[key];
  }
  return node;
}

function blockAddress(document: Record<string, unknown>, seat: SeatOfRecord): BlockAddress {
  if (seat.seat === 'plan') return { path: ['planner'], camel: ['planner'] };
  if (seat.seat === 'review') {
    return valueAt(document, ['reviewer']) === undefined
      ? { path: ['planner'], camel: ['planner'] }
      : { path: ['reviewer'], camel: ['reviewer'] };
  }
  const profile = seat.profile;
  if (
    profile !== undefined &&
    valueAt(document, ['implementerProfiles', 'profiles', profile]) !== undefined
  ) {
    return {
      path: ['implementer_profiles', 'profiles', profile],
      camel: ['implementerProfiles', 'profiles', profile],
    };
  }
  return { path: ['implementer'], camel: ['implementer'] };
}

function valueKeepingFallback(
  runner: SeatRunnerValue,
  existing: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const value = toYaml(runner);
  const fallback = existing?.['fallback'];
  if (fallback !== undefined && value['fallback'] === undefined) value['fallback'] = fallback;
  return value;
}

function existingBlock(
  document: Record<string, unknown>,
  camel: readonly string[],
): Record<string, unknown> | undefined {
  return narrowRecord(valueAt(document, camel)) ?? undefined;
}

/**
 * Writes one seat into `config.yaml` against the revision the halt read: the named
 * block only — `planner`, `implementer`, the failing implementer profile or
 * `reviewer` — so every other seat and the file's own comments stay byte for byte.
 * A revision the file no longer carries is a conflict and writes nothing; the
 * block keeps its declared fallback. The caller resolves the recovery only on
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
    path: address.path,
    value: valueKeepingFallback(runner, existingBlock(document, address.camel)),
  };
  const result = await transactConfigDocument(projectDir, snapshot.revision, [edit]);
  return result.kind === 'saved' ? 'saved' : 'conflict';
}
