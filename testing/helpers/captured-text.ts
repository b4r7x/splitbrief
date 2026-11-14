import type { ChangedFilesSnapshot } from '../../src/core/schemas/workflow/changed-files.js';

// Fresh captures carry exact bytes and modes in dirtyFileEntries; the legacy
// text field dirtyFileContents stays empty and only loads old snapshots.
export function capturedText(snapshot: ChangedFilesSnapshot, file: string): string | undefined {
  const entry = snapshot.dirtyFileEntries?.[file];
  return entry === undefined || entry === null
    ? undefined
    : Buffer.from(entry.base64, 'base64').toString('utf-8');
}
