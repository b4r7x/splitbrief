import { CODEX_DIR, SKILLS_DIR, SPLITBRIEF_DIR } from '../paths.js';

/** Project-scope skill roots, relative to the project directory, highest precedence first. */
export const PROJECT_SKILL_SCAN_PATHS = [
  `${SPLITBRIEF_DIR}/${SKILLS_DIR}`,
  `.claude/${SKILLS_DIR}`,
  `.agents/${SKILLS_DIR}`,
] as const;

/** Global skill roots, relative to the home directory, highest precedence first. */
export const GLOBAL_SKILL_SCAN_PATHS = [
  `${SPLITBRIEF_DIR}/${SKILLS_DIR}`,
  `.claude/${SKILLS_DIR}`,
  `.agents/${SKILLS_DIR}`,
  `${CODEX_DIR}/${SKILLS_DIR}`,
  `.config/opencode/${SKILLS_DIR}`,
] as const;

/** Display labels for the project roots a scan covers, in precedence order. */
export const PROJECT_SKILL_SCAN_PATH_LABELS: readonly string[] = PROJECT_SKILL_SCAN_PATHS.map(
  (p) => `./${p}`,
);

/** Display labels for the global roots a scan covers, in precedence order. */
export const GLOBAL_SKILL_SCAN_PATH_LABELS: readonly string[] = GLOBAL_SKILL_SCAN_PATHS.map(
  (p) => `~/${p}`,
);
