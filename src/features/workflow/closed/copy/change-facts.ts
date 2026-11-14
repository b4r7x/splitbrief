import { formatScoreSummaryParts } from '../../../../core/formatting.js';
import { SPLITBRIEF_DIR, SESSIONS_DIR } from '../../../../core/paths.js';
import { SOFT_SEP } from '../../../../core/separators.js';
import { stateTone } from '../../../../core/theme/state-tone.js';
import { countNoun } from '../../../../utils/pluralize.js';
import type { SummaryView, ScopeView } from '../view-model.js';
import type { FileRow, RunRow, CopySegment } from './types.js';

/** What the run changed: the count, then one row per listed file. */
export function changedRows(view: SummaryView, files: readonly FileRow[]): RunRow[] {
  const changed = view.files.changed;
  if (changed === null || changed.length === 0) return [];
  const testFiles = view.digest.testFiles;
  const partial = view.files.partial.size;
  return [
    {
      label: 'Files',
      segments: [
        { text: countNoun(changed.length, 'file'), tone: 'textDim' },
        ...(testFiles > 0
          ? [{ text: countNoun(testFiles, 'test file'), tone: 'textDim' as const }]
          : []),
        ...(partial > 0 ? [{ text: `${partial} partial`, tone: 'warning' as const }] : []),
      ],
    },
    ...files.map((file): RunRow => {
      const path: CopySegment = { text: file.path, tone: 'textDim', path: file.path };
      return {
        label: '',
        segments: [
          file.partial
            ? {
                spans: [
                  path,
                  { text: SOFT_SEP, tone: 'textDim' },
                  { text: 'partial', tone: 'warning' },
                ],
              }
            : path,
        ],
      };
    }),
  ];
}

export function applyUndoRows(applyUndo: SummaryView['applyUndo']): RunRow[] {
  if (applyUndo === null) return [];
  const conflicts = applyUndo.conflicts.length;
  return [
    {
      label: 'Apply',
      segments: [
        {
          spans: [
            { text: 'undone', tone: stateTone('attention') },
            ...(conflicts === 0
              ? []
              : [{ text: `, ${countNoun(conflicts, 'conflict')} kept`, tone: 'textDim' as const }]),
          ],
        },
      ],
    },
  ];
}

export function qualityRows(quality: SummaryView['quality']): RunRow[] {
  if (quality === null) return [];
  const spans = formatScoreSummaryParts(quality.score, quality, 'quality').map(
    (part): CopySegment => ({
      text: part.text,
      tone:
        part.kind === 'error'
          ? stateTone('failed')
          : part.kind === 'warning' || (part.kind === 'score' && !quality.passed)
            ? stateTone('attention')
            : 'textDim',
    }),
  );
  return [{ label: 'Briefs', segments: [{ spans }] }];
}

/**
 * The packet is named once, project-relative: the record keeps only the file name, and the session
 * it belongs to is the directory. A record that already carries a path is trusted as it stands.
 */
export function packetPath(view: SummaryView): string | null {
  if (view.review.kind !== 'written') return null;
  const stored = view.review.markdownPath;
  if (stored === '') return null;
  if (stored.includes('/')) return stored;
  const sessionId = view.run.sessionId;
  if (sessionId === '') return stored;
  return `${SPLITBRIEF_DIR}/${SESSIONS_DIR}/${sessionId}/${stored}`;
}

export function scopeCleanSegment(scope: ScopeView): CopySegment | null {
  if (scope.kind === 'not-run' || scope.errors + scope.warnings !== 0) return null;
  return { text: 'clean', tone: stateTone('passed') };
}

export function scopeSegments(scope: ScopeView): CopySegment[] {
  if (scope.kind === 'not-run') return [{ text: 'not checked', tone: 'textDim' }];
  const clean = scopeCleanSegment(scope);
  if (clean !== null) return [clean];
  return [
    ...(scope.errors > 0
      ? [{ text: countNoun(scope.errors, 'error'), tone: stateTone('failed') }]
      : []),
    ...(scope.warnings > 0
      ? [{ text: countNoun(scope.warnings, 'warning'), tone: stateTone('attention') }]
      : []),
  ];
}

export function filesRows(view: SummaryView): FileRow[] {
  return (view.files.changed ?? []).map((path) => fileRow(view, path));
}

export function fileRow(view: SummaryView, path: string): FileRow {
  return { path, partial: view.files.partial.has(path) };
}
