import type {
  ActiveDriftChain,
  DriftChainState,
  EmittedChain,
} from '../../../core/schemas/drift-chain.js';
import type { Task, TaskId } from '../../../core/schemas/task.js';
import { emptyActiveChain } from './chain-state.js';
import { clamp01 } from '../../../utils/math.js';
import { matchesGlob } from '../../../utils/path-patterns.js';

export type DriftChainUpdate = {
  state: DriftChainState;
  emitted: EmittedChain | undefined;
};

export function computePerTaskOutOfBounds(
  task: Task,
  taskChangedFiles: string[],
  dependsOnFiles: string[] = [],
): Set<string> {
  if (taskChangedFiles.length === 0) return new Set();

  const inBoundsPatterns = task.scope?.inBounds ?? [];
  const approvedPatterns = task.scope?.approvedOutOfBounds ?? [];
  const dependsOn = new Set(dependsOnFiles);

  const result = new Set<string>();

  for (const file of taskChangedFiles) {
    if (file === task.file) continue;
    if (dependsOn.has(file)) continue;
    if (inBoundsPatterns.some((p) => matchesGlob(file, p))) continue;
    if (approvedPatterns.some((p) => file.includes(p))) continue;
    result.add(file);
  }

  return result;
}

function computeScore(chain: ActiveDriftChain, overlapCount: number, unionSize: number): number {
  const lengthTerm = (Math.min(chain.entries.length, 5) / 5) * 0.3;
  const overlapTerm = chain.entries.length < 2 ? 0 : (overlapCount / unionSize) * 0.5;
  const newFilesTerm = (Math.min(chain.uniqueFiles.length, 10) / 10) * 0.2;
  return clamp01(lengthTerm + overlapTerm + newFilesTerm);
}

function representativePath(entries: ActiveDriftChain['entries']): string {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const file of entry.outOfBoundsFiles) {
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return '';

  let bestFile = '';
  let bestCount = -1;
  for (const [file, count] of counts) {
    if (count > bestCount || (count === bestCount && file < bestFile)) {
      bestFile = file;
      bestCount = count;
    }
  }
  return bestFile;
}

export function analyzeDriftChain(
  state: DriftChainState,
  taskId: TaskId,
  outOfBoundsFiles: Set<string>,
  threshold: number,
): DriftChainUpdate {
  if (outOfBoundsFiles.size === 0) {
    return {
      state: { ...state, activeChain: emptyActiveChain() },
      emitted: undefined,
    };
  }

  const currentFiles = Array.from(outOfBoundsFiles);
  const prevEntry = state.activeChain.entries.at(-1);

  let newEntries: ActiveDriftChain['entries'];
  let newUniqueFiles: string[];
  let overlapCount = 0;
  let unionSize = 0;

  if (prevEntry !== undefined) {
    const prevSet = new Set(prevEntry.outOfBoundsFiles);
    const overlap = currentFiles.filter((f) => prevSet.has(f));
    overlapCount = overlap.length;

    if (overlapCount >= 1) {
      newEntries = [...state.activeChain.entries, { taskId, outOfBoundsFiles: currentFiles }];
      const unionSet = new Set([...prevEntry.outOfBoundsFiles, ...currentFiles]);
      unionSize = unionSet.size;

      const existingUnique = new Set(state.activeChain.uniqueFiles);
      const addedUnique = currentFiles.filter((f) => !existingUnique.has(f));
      newUniqueFiles = [...state.activeChain.uniqueFiles, ...addedUnique];
    } else {
      newEntries = [{ taskId, outOfBoundsFiles: currentFiles }];
      newUniqueFiles = [...currentFiles];
      overlapCount = 0;
      unionSize = currentFiles.length;
    }
  } else {
    newEntries = [{ taskId, outOfBoundsFiles: currentFiles }];
    newUniqueFiles = [...currentFiles];
    overlapCount = 0;
    unionSize = currentFiles.length;
  }

  const updatedChain: ActiveDriftChain = {
    entries: newEntries,
    uniqueFiles: newUniqueFiles,
    score: 0,
  };

  const score = computeScore(updatedChain, overlapCount, unionSize);
  const finalChain: ActiveDriftChain = { ...updatedChain, score };

  const alreadyEmitted = state.emittedChains.some((e) => e.detectedAtTaskId === taskId);

  let emitted: EmittedChain | undefined;
  let newEmittedChains = state.emittedChains;

  if (score >= threshold && !alreadyEmitted) {
    emitted = {
      chainLength: finalChain.entries.length,
      score,
      uniqueOutOfBoundsFiles: finalChain.uniqueFiles,
      representativePath: representativePath(finalChain.entries),
      detectedAtTaskId: taskId,
    };
    newEmittedChains = [...state.emittedChains, emitted];
  }

  return {
    state: { ...state, activeChain: finalChain, emittedChains: newEmittedChains },
    emitted,
  };
}
