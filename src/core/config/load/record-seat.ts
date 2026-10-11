import YAML, { isMap, isNode, isScalar, isSeq } from 'yaml';
import { fromYaml, loadedKey, toYaml } from './transform.js';
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

function valueAt(document: unknown, camel: readonly string[]): unknown {
  let node: unknown = document;
  for (const key of camel) {
    if (isMap(node)) {
      node = node.items.findLast(
        (pair) =>
          isScalar(pair.key) &&
          typeof pair.key.value === 'string' &&
          loadedKey(pair.key.value, []) === key,
      )?.value;
      continue;
    }
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

function orderedSeatBlock(
  runner: Record<string, unknown>,
  previous: Record<string, unknown>,
): Record<string, unknown> {
  const keys = new Set([
    'kind',
    'tool',
    'provider',
    'model',
    'effort',
    'variant',
    ...Object.keys(previous),
    ...Object.keys(runner),
  ]);
  keys.delete('fallback');
  const ordered = Object.fromEntries(
    [...keys].filter((key) => runner[key] !== undefined).map((key) => [key, runner[key]]),
  );
  const fallback = narrowRecord(runner.fallback);
  if (fallback !== null) ordered.fallback = orderedSeatBlock(fallback, {});
  return ordered;
}

function commentsIn(node: unknown): string[] {
  const comments: string[] = [];
  if (isNode(node)) {
    YAML.visit(node, {
      Node: (_key, child) => {
        if (child.commentBefore) comments.push(child.commentBefore);
        if (child.comment) comments.push(child.comment);
      },
    });
  }
  return comments;
}

function preserveSeatComments(next: unknown, previous: unknown): void {
  if (!isNode(next) || !isNode(previous)) return;
  if (previous.commentBefore !== undefined) next.commentBefore = previous.commentBefore;
  if (previous.comment !== undefined) next.comment = previous.comment;
  if (previous.spaceBefore !== undefined) next.spaceBefore = previous.spaceBefore;
  const removedComments: string[] = [];
  if (isMap(next) && isMap(previous)) {
    for (const pair of previous.items) {
      const replacement = next.items.find(
        (item) =>
          isScalar(pair.key) &&
          typeof pair.key.value === 'string' &&
          isScalar(item.key) &&
          typeof item.key.value === 'string' &&
          loadedKey(pair.key.value, []) === loadedKey(item.key.value, []),
      );
      if (replacement === undefined) {
        removedComments.push(...commentsIn(pair.key), ...commentsIn(pair.value));
      } else {
        preserveSeatComments(replacement.key, pair.key);
        preserveSeatComments(replacement.value, pair.value);
      }
    }
  } else if (isSeq(next) && isSeq(previous)) {
    for (const [index, item] of previous.items.entries()) {
      const replacement = next.items[index];
      if (replacement === undefined) removedComments.push(...commentsIn(item));
      else preserveSeatComments(replacement, item);
    }
  }
  if (removedComments.length > 0) {
    next.comment = [next.comment, ...removedComments]
      .filter((comment) => comment !== null && comment !== undefined)
      .join('\n');
  }
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
  const camelAddress = address.map((key) => loadedKey(key, []));
  const previous = narrowRecord(valueAt(document, camelAddress)) ?? {};
  const value = snapshot.document.createNode(orderedSeatBlock(toYaml(runner), toYaml(previous)));
  preserveSeatComments(value, valueAt(snapshot.document.contents, camelAddress));
  const edit: ConfigDocumentEdit = {
    path: address,
    value,
  };
  const result = await transactConfigDocument(projectDir, snapshot.revision, [edit]);
  return result.kind === 'saved' ? 'saved' : 'conflict';
}
