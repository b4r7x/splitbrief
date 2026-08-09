import type {
  EvidenceLedger,
  EvidenceTask,
  EvidenceValidationEntry,
} from '../../../core/schemas/evidence.js';

const DETAIL_CHAR_CAP = 800;
const SECTION_CHAR_CAP = 30_000;

function entryHeadline(entry: EvidenceValidationEntry): string {
  const command = entry.command !== undefined ? ` (\`${entry.command}\`)` : '';
  const retry = entry.retryState !== undefined ? ` [${entry.retryState}]` : '';
  const exempt = entry.baselineExempt === true ? ' [pre-existing failure]' : '';
  return `- ${entry.stage}${command}: ${entry.passed ? 'passed' : 'failed'}${retry}${exempt}`;
}

function capDetailTail(detail: string): string {
  const trimmed = detail.trim();
  if (trimmed.length <= DETAIL_CHAR_CAP) return trimmed;
  return `…${trimmed.slice(-(DETAIL_CHAR_CAP - 1))}`;
}

function entryPriority(entry: EvidenceValidationEntry): number {
  if (!entry.passed) return 0;
  if (entry.retryState === 'failed' || entry.retryState === 'escalated') return 1;
  if (entry.retryState === 'initial-failure' || entry.retryState === 'retry') return 2;
  return 3;
}

function formatEntryBlock(entry: EvidenceValidationEntry): string {
  const lines: string[] = [entryHeadline(entry)];
  const detail = entry.output ?? entry.errorSummary;
  if (detail !== undefined && detail.trim() !== '') {
    lines.push('', '```', capDetailTail(detail), '```', '');
  }
  return lines.join('\n');
}

function taskHeader(task: EvidenceTask): string {
  return `### ${task.id} — ${task.title} (status: ${task.status})`;
}

function omissionMarker(omitted: number): string {
  return `[… ${omitted} entries omitted …]`;
}

type IndexedEntry = {
  task: EvidenceTask;
  entry: EvidenceValidationEntry;
  taskIndex: number;
  globalIndex: number;
};

function indexValidationEntries(ledger: EvidenceLedger): IndexedEntry[] {
  const indexed: IndexedEntry[] = [];
  let globalIndex = 0;
  for (let taskIndex = 0; taskIndex < ledger.tasks.length; taskIndex++) {
    const task = ledger.tasks[taskIndex];
    if (task === undefined) continue;
    for (const entry of task.validation) {
      indexed.push({ task, entry, taskIndex, globalIndex });
      globalIndex += 1;
    }
  }
  return indexed;
}

function sectionSize(indexed: IndexedEntry[], included: Set<number>): number {
  const omitted = indexed.length - included.size;
  let size = 0;
  const tasksSeen = new Set<number>();

  for (const item of indexed) {
    if (!included.has(item.globalIndex)) continue;
    if (!tasksSeen.has(item.taskIndex)) {
      if (tasksSeen.size > 0) size += 2;
      size += taskHeader(item.task).length + 1;
      tasksSeen.add(item.taskIndex);
    }
    size += formatEntryBlock(item.entry).length + 1;
  }

  if (omitted > 0) {
    if (size > 0) size += 2;
    size += omissionMarker(omitted).length;
  }

  return size;
}

function selectIncludedEntries(indexed: IndexedEntry[]): Set<number> {
  if (indexed.length === 0) return new Set();

  const byPriority = [...indexed].sort((a, b) => {
    const priorityDelta = entryPriority(a.entry) - entryPriority(b.entry);
    if (priorityDelta !== 0) return priorityDelta;
    return a.globalIndex - b.globalIndex;
  });

  const included = new Set<number>();
  for (const item of byPriority) {
    const candidate = new Set(included);
    candidate.add(item.globalIndex);
    if (sectionSize(indexed, candidate) <= SECTION_CHAR_CAP) {
      included.add(item.globalIndex);
    }
  }
  return included;
}

function renderSection(indexed: IndexedEntry[], included: Set<number>): string {
  const omitted = indexed.length - included.size;
  const sections: string[] = [];
  const tasksSeen = new Set<number>();

  for (const item of indexed) {
    if (!included.has(item.globalIndex)) continue;
    if (!tasksSeen.has(item.taskIndex)) {
      sections.push(taskHeader(item.task));
      tasksSeen.add(item.taskIndex);
    }
    sections.push(formatEntryBlock(item.entry));
  }

  if (omitted > 0) {
    sections.push(omissionMarker(omitted));
  }

  return sections.join('\n\n');
}

/**
 * Renders the ledger's recorded validation runs — command, verdict, and
 * captured output verbatim — for the final review prompt. The review quotes
 * this record instead of re-deriving (or inventing) validation results.
 */
export function formatValidationEvidenceForPrompt(
  ledger: EvidenceLedger | null,
): string | undefined {
  if (ledger === null) return undefined;

  const indexed = indexValidationEntries(ledger);
  if (indexed.length === 0) return undefined;

  const included = selectIncludedEntries(indexed);
  if (included.size === 0) return undefined;

  return renderSection(indexed, included);
}
