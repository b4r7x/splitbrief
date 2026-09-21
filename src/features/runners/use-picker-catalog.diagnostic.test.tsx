import { Text } from 'ink';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/project/detection.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import type { CliToolDetection } from '../../core/discovery/detection.js';
import type { ProbeOutcomeKind } from '../../core/discovery/runner-evidence.js';
import type { ScopedCliCatalogAttempt } from '../../engine/detection/cli-catalog-outcomes.js';
import type { DetectionServiceResult } from '../../engine/detection/service.js';
import {
  formatCatalogDiagnostic,
  formatToolsByline,
  pickerListingSource,
} from './picker-format.js';
import { usePickerCatalog, type PickerCatalog } from './use-picker-catalog.js';

const contexts = {
  readiness: 'diag-readiness',
  modelsDev: 'diag-models-dev',
  cliModels: 'diag-cli-models',
};

function cliCatalogAttempt(input: {
  tool: 'codex' | 'opencode';
  models?: readonly string[];
  failure?: Exclude<ProbeOutcomeKind, 'success'>;
}): ScopedCliCatalogAttempt {
  return {
    connection: {
      tool: input.tool,
      contextKey: `${input.tool}-context`,
    },
    outcome:
      input.failure === undefined
        ? { kind: 'success', value: (input.models ?? []).map((id) => ({ id })) }
        : { kind: input.failure },
  };
}

function cliCatalogResult(
  attempts: readonly ScopedCliCatalogAttempt[],
  cliTools: CliToolDetection[] = [],
): DetectionServiceResult {
  return {
    providers: [],
    cliTools,
    catalog: null,
    cliModels: attempts,
    generation: 1,
    outcomes: {
      readiness: {
        kind: 'fresh',
        origin: 'request',
        snapshot: {
          source: 'readiness',
          contextKey: contexts.readiness,
          generation: 1,
          requestId: 1,
          fetchedAt: 100,
          validatedAt: 100,
          stale: false,
          value: { providers: [], cliTools },
        },
      },
      modelsDev: {
        kind: 'not-run',
        source: 'models-dev',
        contextKey: contexts.modelsDev,
        reason: 'uninitialized',
      },
      cliModels: {
        kind: 'fresh',
        origin: 'request',
        snapshot: {
          source: 'cli-models',
          contextKey: contexts.cliModels,
          generation: 1,
          requestId: 1,
          fetchedAt: 100,
          validatedAt: 100,
          stale: false,
          value: attempts,
        },
      },
    },
  };
}

function publishCliCatalogs(
  attempts: readonly ScopedCliCatalogAttempt[],
  cliTools: CliToolDetection[] = [],
): void {
  const request = detectionStore.beginRefresh({ contexts });
  expect(detectionStore.publish({ result: cliCatalogResult(attempts, cliTools), request })).toBe(
    true,
  );
}

let captured: PickerCatalog['catalogDiagnostic'];

function Probe({ role, toolId }: { role: 'planner' | 'implementer'; toolId: string }) {
  captured = usePickerCatalog(role, 0, toolId).catalogDiagnostic;
  return <Text>probe</Text>;
}

let capturedRows: PickerCatalog['rightRows'] = [];

function ModelsProbe({ toolId }: { toolId: string }) {
  capturedRows = usePickerCatalog('planner', 0, toolId).rightRows;
  return <Text>models</Text>;
}

let capturedCatalog: PickerCatalog | undefined;

function BylineProbe({ toolId }: { toolId: string }) {
  capturedCatalog = usePickerCatalog('planner', 0, toolId);
  return <Text>byline</Text>;
}

describe('usePickerCatalog catalog diagnostic', () => {
  beforeEach(() => {
    captured = undefined;
    capturedCatalog = undefined;
    configStore.__testReset({ projectDir: '/tmp/project', config: makeConfig() });
    detectionStore.reset();
    modelCacheStore.reset();
    overlayStore.reset();
  });

  it('reports not-probed for a native-catalog tool before any catalog lane completes', () => {
    const ui = renderFeature(<Probe role="planner" toolId="codex" />);

    expect(captured).toEqual({ kind: 'not-probed' });
    ui.unmount();
  });

  it('keeps a browsed unconfigured tool at not-probed after another tool was probed', () => {
    publishCliCatalogs([cliCatalogAttempt({ tool: 'codex', models: [] })]);

    const ui = renderFeature(<Probe role="planner" toolId="opencode" />);

    expect(captured).toEqual({ kind: 'not-probed' });
    ui.unmount();
  });

  it('clears the diagnostic after a successful probe, even an empty one', () => {
    publishCliCatalogs([cliCatalogAttempt({ tool: 'codex', models: [] })]);

    const ui = renderFeature(<Probe role="planner" toolId="codex" />);

    expect(captured).toBeUndefined();
    ui.unmount();
  });

  it.each(['missing-credential', 'malformed'] as const)(
    'surfaces a %s probe failure for the probed tool',
    (failure) => {
      publishCliCatalogs([cliCatalogAttempt({ tool: 'codex', failure })]);

      const ui = renderFeature(<Probe role="planner" toolId="codex" />);

      expect(captured).toEqual({ kind: 'probe-failed', failure });
      ui.unmount();
    },
  );

  it('reports a tool without a listing command as unsupported', () => {
    const ui = renderFeature(<Probe role="planner" toolId="claude-code" />);

    expect(captured).toEqual({ kind: 'unsupported' });
    ui.unmount();
  });

  // The unsupported verdict is about a CLI that cannot enumerate its models; an
  // API provider has nothing to miss, so it must claim nothing.
  it('claims nothing for an API provider', () => {
    const ui = renderFeature(<Probe role="planner" toolId="anthropic" />);

    expect(captured).toBeUndefined();
    ui.unmount();
  });

  // The survivor in the gallery's malformed scenario is the structural Auto row, which is why the guidance placeholder path never fired.
  it('sends the malformed sentence to the byline even though a row survives', () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'cli', tool: 'opencode', model: 'opencode-go/deepseek-v4-flash' },
      }),
    });
    publishCliCatalogs([cliCatalogAttempt({ tool: 'opencode', failure: 'malformed' })]);

    const ui = renderFeature(<BylineProbe toolId="opencode" />);

    expect(capturedCatalog?.catalogDiagnostic).toEqual({
      kind: 'probe-failed',
      failure: 'malformed',
    });
    expect(capturedCatalog?.modelRowCount).toBeGreaterThan(0);

    const listing = pickerListingSource('opencode');
    const line = formatToolsByline({
      toolName: 'OpenCode CLI',
      version: undefined,
      modelCount: capturedCatalog?.modelRowCount ?? 0,
      rowNoun: listing.rowNoun,
      rowNounPlural: listing.rowNounPlural,
      source: listing.source,
      unverifiedForPlan: listing.unverifiedForPlan,
      diagnostic: capturedCatalog?.catalogDiagnostic,
      lane: 'ready',
      capabilities: ['Network', 'Shell'],
      billing: 'provider-dependent',
      budget: 108,
    });

    expect(line).toBe(
      formatCatalogDiagnostic({ kind: 'probe-failed', failure: 'malformed' }, 'OpenCode CLI'),
    );
    expect(line).not.toContain('Network');
    expect(line).not.toContain('Provider dependent');
    expect(line).not.toContain('from opencode models --verbose');

    ui.unmount();
  });

  it('shows one tool the same diagnostic in the planner and the implementer picker', () => {
    publishCliCatalogs([cliCatalogAttempt({ tool: 'codex', failure: 'timeout' })]);

    const plannerUi = renderFeature(<Probe role="planner" toolId="codex" />);
    const plannerDiagnostic = captured;
    plannerUi.unmount();

    const implementerUi = renderFeature(<Probe role="implementer" toolId="codex" />);
    expect(captured).toEqual(plannerDiagnostic);
    expect(captured).toEqual({ kind: 'probe-failed', failure: 'timeout' });
    implementerUi.unmount();
  });
});

describe('usePickerCatalog provider variant threading', () => {
  beforeEach(() => {
    capturedRows = [];
    configStore.__testReset({ projectDir: '/tmp/project', config: makeConfig() });
    detectionStore.reset();
    modelCacheStore.reset();
    overlayStore.reset();
  });

  it('keeps the persisted variant as the merged row id and sorts configured providers first', () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'cli', tool: 'opencode', model: 'opencode-go/deepseek-v4-flash' },
      }),
    });
    publishCliCatalogs(
      [
        cliCatalogAttempt({
          tool: 'opencode',
          models: ['ollama-cloud/deepseek-v4-flash', 'opencode-go/deepseek-v4-flash'],
        }),
      ],
      [
        cliDetectionFor('ready', 'opencode', {
          providerAuth: { kind: 'read', facts: [{ provider: 'OpenCode Go', source: 'oauth' }] },
        }),
      ],
    );

    const ui = renderFeature(<ModelsProbe toolId="opencode" />);

    const merged = capturedRows
      .filter((row) => row.kind === 'model')
      .map((row) => row.model)
      .find((model) => model.variants !== undefined && model.variants.length === 2);
    expect(merged?.id).toBe('opencode-go/deepseek-v4-flash');
    expect(merged?.variants?.map((variant) => variant.fullId)).toEqual([
      'opencode-go/deepseek-v4-flash',
      'ollama-cloud/deepseek-v4-flash',
    ]);
    ui.unmount();
  });
});
