import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeExecutable } from '#testing/helpers/cli-executable.js';
import { cliDetectionsFor, cliReadinessFactsFor } from '#testing/helpers/factories/detection.js';
import { stubSignInHome } from '#testing/helpers/sign-in-home.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { installToolShim, signInCodexShim } from '#testing/helpers/tool-shim.js';
import {
  CLI_READINESS_STATES,
  type CliReadinessState,
  type CliToolDetection,
} from '../../../src/core/discovery/detection/tool.js';
import {
  CLI_TOOL_CATALOG,
  LISTED_CLI_TOOL_IDS,
} from '../../../src/core/runners/cli-tool/catalog.js';
import { deriveCliReadinessStatus } from '../../../src/core/schemas/readiness.js';
import {
  detectAll,
  detectAvailableCliReadiness,
  detectAvailableCliTools,
} from '../../../src/engine/detection/detect.js';
import { detectionStore } from '../../../src/stores/discovery/detection.js';
import {
  assemblePickerDescriptors,
  buildPickerOptions,
  type PickerOption,
} from '../../../src/features/runners/model-catalog/options.js';

/**
 * Reachability is a property of the whole chain, so every step below is the
 * production one: `detectAll` → `detectAvailableCliTools` → `detectionStore`
 * → `buildPickerOptions`. A probed state comes from the real probe of a fake
 * `codex`; a refused executable runs no probe.
 */
async function cliPickerOptions(
  role: 'planner' | 'implementer',
  detectCliTools: () => Promise<CliToolDetection[]>,
): Promise<PickerOption[]> {
  const detection = await detectAll({
    detectProviders: async () => [],
    detectCliTools,
  });
  detectionStore.setDetection(detection);

  const snapshot = detectionStore.get();
  return buildPickerOptions(
    role,
    assemblePickerDescriptors(),
    { cliTools: snapshot.cliTools, providers: snapshot.providers },
    undefined,
  ).filter((option) => option.kind === 'cli');
}

/**
 * States the picker branches on but detection cannot emit. `disabled` derives
 * only from `enabled: false`, and no detection entry point sets it — the picker
 * branch is dead until one does. Listing it here keeps the gap reviewable: a
 * newly unreachable state fails this file instead of passing silently.
 */
const UNREACHABLE_PICKER_STATES: readonly CliReadinessState[] = ['disabled'];

/** The `--version` answer and the sign-in of a fake `codex` that its real probe reads as `state`. */
const PROBED_CODEX: Partial<
  Record<CliReadinessState, Readonly<{ version: string; signedIn: boolean }>>
> = {
  ready: { version: CLI_TOOL_CATALOG.codex.compatibility.testedVersion, signedIn: true },
  unauthenticated: { version: CLI_TOOL_CATALOG.codex.compatibility.testedVersion, signedIn: false },
  incompatible: { version: '0.39.9', signedIn: true },
  unverified: { version: '0.40.0-rc.1', signedIn: true },
};

/** The real detection of one fake `codex` whose probe reads as `state`. */
async function probedCodex(state: CliReadinessState): Promise<() => Promise<CliToolDetection[]>> {
  const shape = PROBED_CODEX[state];
  if (shape === undefined) throw new Error(`no fake codex reads as ${state}`);
  const directory = createTempDir('reachability-codex');
  shimDirs.push(directory);
  await installToolShim(
    directory,
    'codex',
    signInCodexShim({
      argvLog: join(directory, 'argv.log'),
      versionLines: [`printf '%s\\n' 'codex-cli ${shape.version}'`, 'exit 0'],
    }),
  );
  await stubSignInHome(join(directory, 'home'), shape.signedIn ? ['codex'] : []);
  vi.stubEnv('PATH', directory);
  return () => detectAvailableCliTools({ tools: ['codex'] });
}

/**
 * The real detection of every listed tool over a PATH that finds none of them (`unavailable`)
 * or finds each as a file inside the project (`untrusted`). A refused executable runs no probe.
 */
function refusedTools(state: 'unavailable' | 'untrusted'): () => Promise<CliToolDetection[]> {
  const projectDir = createTempDir('reachability-project');
  shimDirs.push(projectDir);
  if (state === 'untrusted') {
    for (const tool of LISTED_CLI_TOOL_IDS) {
      makeExecutable(join(projectDir, CLI_TOOL_CATALOG[tool].command));
    }
  }
  vi.stubEnv('PATH', projectDir);
  return () => detectAvailableCliTools({ projectDir });
}

const shimDirs: string[] = [];

describe('CLI readiness reachability from the real detection producer', () => {
  let configHome: string;

  // An OpenCode or Kilo that stores no credential reads its own config, so it reads an empty one, never the tester's.
  beforeEach(() => {
    detectionStore.reset();
    configHome = createTempDir('reachability-config');
    vi.stubEnv('XDG_CONFIG_HOME', join(configHome, 'xdg'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    cleanupTempDir(configHome);
    for (const directory of shimDirs.splice(0)) cleanupTempDir(directory);
  });

  it('admits every listed CLI tool as ready and selectable on a best-case probe', async () => {
    const options = await cliPickerOptions('planner', async () =>
      cliDetectionsFor('ready', LISTED_CLI_TOOL_IDS),
    );
    const byId = new Map(options.map((option) => [option.id, option]));

    expect([...byId.keys()].toSorted()).toEqual([...LISTED_CLI_TOOL_IDS].toSorted());
    for (const tool of LISTED_CLI_TOOL_IDS) {
      const option = byId.get(tool);
      expect(option?.status).toEqual({ state: 'ready', remediation: null });
      expect(option?.available).toBe(true);
      expect(option?.version).toBe(CLI_TOOL_CATALOG[tool].compatibility.testedVersion);
    }
  });

  it.each(CLI_READINESS_STATES.filter((state) => !UNREACHABLE_PICKER_STATES.includes(state)))(
    'reaches picker status %s through the real detection chain',
    async (state) => {
      const options =
        state === 'unavailable' || state === 'untrusted'
          ? await cliPickerOptions('implementer', refusedTools(state))
          : (await cliPickerOptions('implementer', await probedCodex(state))).filter(
              (option) => option.id === 'codex',
            );

      expect(options.length).toBeGreaterThan(0);
      for (const option of options) {
        expect(option.status.state).toBe(state);
        expect(option.available).toBe(state === 'ready');
        if (state !== 'ready') expect(option.status.remediation).toBeTruthy();
      }
    },
  );

  it('proves the listed unreachable state stays unreachable', async () => {
    const facts = cliReadinessFactsFor('ready', 'codex');
    // `disabled` is derivable, but only from `enabled: false` …
    expect(deriveCliReadinessStatus(facts)).toBe('ready');
    expect(deriveCliReadinessStatus({ ...facts, enabled: false })).toBe('disabled');

    // … and detection has no `enabled` fact to falsify, so each result reads as
    // enabled. Wiring one makes this fail, which is the prompt to move the state
    // out of UNREACHABLE_PICKER_STATES.
    const emptyPathDir = createTempDir('reachability-empty-path');
    shimDirs.push(emptyPathDir);
    vi.stubEnv('PATH', emptyPathDir);
    const results = await detectAvailableCliReadiness();

    expect(results).toHaveLength(LISTED_CLI_TOOL_IDS.length);
    expect(results.every((result) => result.enabled && result.status !== 'disabled')).toBe(true);
  });
});
