import { z } from 'zod';
import { getSplitbriefPath, UI_PREFS_FILE } from './paths.js';
import { readValidatedJson, writeSecureFile } from '../lib/fs.js';
import { warnError } from '../lib/warn.js';

export interface UiPrefs {
  sidebarVisible: boolean;
}

export const DEFAULT_UI_PREFS: Readonly<UiPrefs> = Object.freeze({
  sidebarVisible: true,
});

function uiPrefsPath(projectDir: string): string {
  return getSplitbriefPath(projectDir, UI_PREFS_FILE);
}

const UiPrefsSchema = z.object({
  sidebarVisible: z.boolean().default(DEFAULT_UI_PREFS.sidebarVisible),
});

function parseUiPrefs(value: unknown): UiPrefs | null {
  const result = UiPrefsSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function readUiPrefs(projectDir: string): UiPrefs {
  return readValidatedJson(
    uiPrefsPath(projectDir),
    parseUiPrefs,
    DEFAULT_UI_PREFS,
    'ui-prefs: failed to read',
  );
}

export function writeUiPrefs(projectDir: string, prefs: UiPrefs): void {
  try {
    writeSecureFile(uiPrefsPath(projectDir), JSON.stringify(prefs, null, 2) + '\n');
  } catch (err) {
    warnError('ui-prefs: failed to save', err);
  }
}
