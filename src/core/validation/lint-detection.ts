import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const BIOME_CONFIG_FILES = ['biome.json', 'biome.jsonc'];

const PRETTIER_CONFIG_FILE = /^(\.prettierrc|prettier\.config\.)/;

// SPLITBRIEF formats the brief's changed files with the project's own formatter
// after every hand-back, so a layout-only lint failure never reaches a check;
// only those files are rewritten, so attribution holds. ESLint `--fix` rewrites
// semantics as well as layout and is never run.
export function detectFormatFixCommand(projectDir: string): string | null {
  if (BIOME_CONFIG_FILES.some((file) => existsSync(join(projectDir, file)))) {
    return 'npx biome format --write';
  }
  // A project directory that is not there has no formatter, the way it has no linter.
  if (!existsSync(projectDir)) return null;
  if (readdirSync(projectDir).some((entry) => PRETTIER_CONFIG_FILE.test(entry))) {
    return 'npx prettier --write';
  }
  return null;
}
