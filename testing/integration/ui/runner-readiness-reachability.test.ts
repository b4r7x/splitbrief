import { beforeEach, describe, expect, it } from 'vitest';
import { cliReadinessFactsFor, PROBE_EXECUTABLE } from '#testing/helpers/factories/detection.js';
import {
  CLI_READINESS_STATES,
  type CliExecutableIdentity,
  type CliReadinessState,
} from '../../../src/core/discovery/detection.js';
import {
  CLI_TOOL_CATALOG,
  CLI_TOOL_IDS,
  defaultCliAuthChannel,
} from '../../../src/core/runners/cli-tool-catalog.js';
import {
  deriveCliReadiness,
  deriveCliReadinessStatus,
} from '../../../src/core/schemas/readiness.js';
import { detectAll, detectAvailableCliTools } from '../../../src/engine/detection/detect.js';
import { detectionStore } from '../../../src/stores/project/detection.js';
import {
  assemblePickerDescriptors,
  buildPickerOptions,
  type PickerOption,
} from '../../../src/features/runners/model-catalog/options.js';
import { error } from '../../../src/utils/error.js';

/**
 * Reachability is a property of the whole chain, so every step below is the
 * production one: `detectAll` → `detectAvailableCliTools` → `detectionStore`
 * → `buildPickerOptions`. Only the
 * two process-touching seams `detectAvailableCliTools` already exposes are
 * substituted, so the run needs no installed tool and no subprocess.
 */
type ProbeOverrides = Readonly<{
  resolveExecutable?: () => Promise<CliExecutableIdentity>;
  state?: CliReadinessState;
}>;

async function cliPickerOptions(
  role: 'planner' | 'implementer',
  overrides: ProbeOverrides = {},
): Promise<PickerOption[]> {
  const state = overrides.state ?? 'ready';
  const resolveExecutable = overrides.resolveExecutable ?? (async () => PROBE_EXECUTABLE);
  const authChannels = Object.fromEntries(
    CLI_TOOL_IDS.map((tool) => [tool, defaultCliAuthChannel(tool).id]),
  );
  const detectCliTools = () =>
    detectAvailableCliTools({
      resolveExecutable,
      probeReadiness: async ({ tool }) => deriveCliReadiness(cliReadinessFactsFor(state, tool)),
      authChannels,
    });

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

describe('CLI readiness reachability from the real detection producer', () => {
  beforeEach(() => {
    detectionStore.reset();
  });

  it('admits every catalog CLI tool as ready and selectable on a best-case probe', async () => {
    const options = await cliPickerOptions('planner');
    const byId = new Map(options.map((option) => [option.id, option]));

    expect([...byId.keys()].toSorted()).toEqual([...CLI_TOOL_IDS].toSorted());
    for (const tool of CLI_TOOL_IDS) {
      const option = byId.get(tool);
      expect(option?.status).toEqual({ state: 'ready', remediation: null });
      expect(option?.available).toBe(true);
      expect(option?.version).toBe(CLI_TOOL_CATALOG[tool].compatibility.testedVersion);
    }
  });

  it.each(CLI_READINESS_STATES.filter((state) => !UNREACHABLE_PICKER_STATES.includes(state)))(
    'reaches picker status %s through the real detection chain',
    async (state) => {
      const resolveExecutable =
        state === 'unavailable'
          ? async () => {
              throw error('cli-executable-unavailable', 'not installed');
            }
          : state === 'untrusted'
            ? async () => {
                throw error('cli-executable-untrusted', 'project-local shadow');
              }
            : undefined;

      const options = await cliPickerOptions('implementer', {
        state,
        ...(resolveExecutable !== undefined && { resolveExecutable }),
      });

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

    // … and detection never hands the probe an `enabled` fact to falsify, so no
    // detection path can reach it. Wiring one makes this fail, which is the
    // prompt to move the state out of UNREACHABLE_PICKER_STATES.
    const enabledArguments: (boolean | undefined)[] = [];
    await detectAvailableCliTools({
      resolveExecutable: async () => PROBE_EXECUTABLE,
      probeReadiness: async (options) => {
        enabledArguments.push(options.enabled);
        return deriveCliReadiness(cliReadinessFactsFor('ready', options.tool));
      },
    });

    expect(enabledArguments.length).toBe(CLI_TOOL_IDS.length);
    expect(enabledArguments.every((enabled) => enabled === undefined)).toBe(true);
  });
});
