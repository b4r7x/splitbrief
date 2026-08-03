import { Text } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/project/detection.js';
import { modelCacheStore } from '../../stores/discovery/model-cache.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import type { CliToolDetection } from '../../core/discovery/detection.js';
import type { ProbeOutcomeKind } from '../../core/discovery/runner-evidence.js';
import type { ScopedCliCatalogAttempt } from '../../engine/detection/cli-catalog-outcomes.js';
import type { DetectionServiceResult } from '../../engine/detection/service.js';
import type { PickerOption } from './model-catalog/options.js';
import { usePickerCatalog, type PickerCatalog } from './use-picker-catalog.js';

const contexts = {
  readiness: 'diag-readiness',
  modelsDev: 'diag-models-dev',
  cliModels: 'diag-cli-models',
};

function cliCatalogAttempt(input: {
  role: 'planner' | 'implementer';
  tool: 'codex' | 'opencode';
  models?: readonly string[];
  failure?: Exclude<ProbeOutcomeKind, 'success'>;
}): ScopedCliCatalogAttempt {
  return {
    connection: {
      role: input.role,
      tool: input.tool,
      contextKey: `${input.role}-${input.tool}-context`,
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

let capturedModels: PickerCatalog['rightModels'] = [];

function ModelsProbe({ toolId }: { toolId: string }) {
  capturedModels = usePickerCatalog('planner', 0, toolId).rightModels;
  return <Text>models</Text>;
}

describe('usePickerCatalog catalog diagnostic', () => {
  beforeEach(() => {
    captured = undefined;
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
    publishCliCatalogs([cliCatalogAttempt({ role: 'planner', tool: 'codex', models: [] })]);

    const ui = renderFeature(<Probe role="planner" toolId="opencode" />);

    expect(captured).toEqual({ kind: 'not-probed' });
    ui.unmount();
  });

  it('clears the diagnostic after a successful probe, even an empty one', () => {
    publishCliCatalogs([cliCatalogAttempt({ role: 'planner', tool: 'codex', models: [] })]);

    const ui = renderFeature(<Probe role="planner" toolId="codex" />);

    expect(captured).toBeUndefined();
    ui.unmount();
  });

  it.each([
    'missing-credential',
    'malformed',
  ] as const)('surfaces a %s probe failure for the probed tool', (failure) => {
    publishCliCatalogs([cliCatalogAttempt({ role: 'planner', tool: 'codex', failure })]);

    const ui = renderFeature(<Probe role="planner" toolId="codex" />);

    expect(captured).toEqual({ kind: 'probe-failed', failure });
    ui.unmount();
  });

  it('does not let another role supply the probe outcome', () => {
    publishCliCatalogs([cliCatalogAttempt({ role: 'planner', tool: 'codex', failure: 'timeout' })]);

    const ui = renderFeature(<Probe role="implementer" toolId="codex" />);

    expect(captured).toEqual({ kind: 'not-probed' });
    ui.unmount();
  });

  it('reports nothing for a tool without a native catalog contract', () => {
    const ui = renderFeature(<Probe role="planner" toolId="claude-code" />);

    expect(captured).toBeUndefined();
    ui.unmount();
  });
});

describe('usePickerCatalog role-scoped Agent SDK status', () => {
  beforeEach(() => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: {
          kind: 'agent-sdk',
          apiKey: 'sk-ant-active-planner',
          model: 'claude-sonnet-4-6',
        },
      }),
    });
    detectionStore.reset();
    modelCacheStore.reset();
    overlayStore.reset();
    vi.stubEnv('ANTHROPIC_API_KEY', 'ambient-test-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses an active Agent SDK stale catalog before ambient credentials without sorting it current-first', () => {
    detectionStore.setDetection({
      cliTools: [],
      providers: [],
      providerOutcomes: [
        {
          connection: { role: 'planner', provider: 'anthropic', contextKey: 'planner-context' },
          state: 'stale',
          catalog: 'populated',
          models: [{ id: 'claude-sonnet-4-6' }],
          fetchedAt: 1,
          validatedAt: 2,
          failure: 'timeout',
          diagnostic: 'Configured provider catalog refresh did not complete.',
        },
        {
          connection: {
            role: 'implementer',
            provider: 'anthropic',
            contextKey: 'implementer-context',
          },
          state: 'fresh',
          catalog: 'populated',
          models: [{ id: 'claude-opus-4-6' }],
          fetchedAt: 1,
          validatedAt: 2,
        },
      ],
    });
    let items: ReturnType<typeof usePickerCatalog>['items'] = [];

    function ItemsProbe() {
      items = usePickerCatalog('planner', 0).items;
      return <Text>projection</Text>;
    }

    const ui = renderFeature(<ItemsProbe />);
    const agentSdk = items.find((item) => item.id === 'agent-sdk');

    expect(agentSdk).toMatchObject({
      isCurrent: true,
      available: false,
      status: {
        state: 'unavailable',
        remediation: 'Last confirmed Agent SDK catalog is stale. Refresh detection.',
      },
    });
    const nonLauncher = items.filter((item) => item.kind !== 'custom-command');
    const alphabetical = nonLauncher
      .map((item) => item.displayName)
      .toSorted((a, b) => a.localeCompare(b));
    expect(nonLauncher.map((item) => item.displayName)).toEqual(alphabetical);
    ui.unmount();
  });

  it('does not let another role supply Agent SDK stale status', () => {
    detectionStore.setDetection({
      cliTools: [],
      providers: [],
      providerOutcomes: [
        {
          connection: {
            role: 'implementer',
            provider: 'anthropic',
            contextKey: 'implementer-context',
          },
          state: 'stale',
          catalog: 'populated',
          models: [{ id: 'claude-opus-4-6' }],
          fetchedAt: 1,
          validatedAt: 2,
          failure: 'timeout',
          diagnostic: 'Configured provider catalog refresh did not complete.',
        },
      ],
    });
    let agentSdk: PickerOption | undefined;

    function AgentSdkProbe() {
      agentSdk = usePickerCatalog('planner', 0).items.find((item) => item.id === 'agent-sdk');
      return <Text>projection</Text>;
    }

    const ui = renderFeature(<AgentSdkProbe />);

    expect(agentSdk).toMatchObject({
      isCurrent: true,
      available: true,
      status: { state: 'ready', remediation: null },
    });
    ui.unmount();
  });
});

describe('usePickerCatalog provider variant threading', () => {
  beforeEach(() => {
    capturedModels = [];
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
          role: 'planner',
          tool: 'opencode',
          models: ['ollama-cloud/deepseek-v4-flash', 'opencode-go/deepseek-v4-flash'],
        }),
      ],
      [
        cliDetectionFor('ready', 'opencode', {
          providerAuth: [{ provider: 'OpenCode Go', source: 'oauth' }],
        }),
      ],
    );

    const ui = renderFeature(<ModelsProbe toolId="opencode" />);

    const merged = capturedModels.find(
      (model) => model.variants !== undefined && model.variants.length === 2,
    );
    expect(merged?.id).toBe('opencode-go/deepseek-v4-flash');
    expect(merged?.variants?.map((variant) => variant.fullId)).toEqual([
      'opencode-go/deepseek-v4-flash',
      'ollama-cloud/deepseek-v4-flash',
    ]);
    ui.unmount();
  });
});
