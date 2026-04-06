import { useState, useEffect, useEffectEvent } from 'react';
import { Box, Text, useApp } from 'ink';
import { useTheme } from '../ui/theme.js';
import { OverlayPanel } from '../ui/overlay-panel.js';
import { Spinner } from '../ui/spinner.js';
import { TwoColumnPicker } from '../components/two-column-picker.js';
import { routerStore } from '../stores/router.js';
import { configStore } from '../stores/config.js';
import { createDefaultConfig, writeConfig } from '../core/config.js';
import { getProvider } from '../engine/providers/registry.js';
import { detectAvailablePlanners, detectAvailableImplementers } from '../engine/detection.js';
import { KNOWN_PLANNER_MODELS } from '../components/known-planner-models.js';
import { buildBackendItems, modelsForProvider } from '../components/implementer-picker.js';
import type { PlannerDetection } from '../engine/detection.js';
import type { ProviderDetection } from '../engine/providers/types.js';
import type { PlannerTool, Config } from '../types.js';
import type { KnownModel } from '../components/known-planner-models.js';

type Step = 'detecting' | 'planner' | 'implementer' | 'done';

interface Selection {
  planner: PlannerTool;
  plannerModel?: string;
  provider: string;
  model: string;
  apiBase?: string;
}

export function SetupScreen() {
  const t = useTheme();
  const { exit } = useApp();
  const route = routerStore.use(s => s);

  const [step, setStep] = useState<Step>('detecting');
  const [planners, setPlanners] = useState<PlannerDetection[] | null>(null);
  const [providers, setProviders] = useState<ProviderDetection[] | null>(null);
  const [selection, setSelection] = useState<Selection>({
    planner: 'claude-code',
    provider: 'ollama',
    model: 'qwen2.5-coder:7b',
  });

  const stableDetect = useEffectEvent(async () => {
    const [p, i] = await Promise.all([detectAvailablePlanners(), detectAvailableImplementers()]);
    setPlanners(p);
    setProviders(i);

    const availPlanners = p.filter(x => x.available);
    if (availPlanners.length > 0) {
      setSelection(s => ({ ...s, planner: availPlanners[0].tool }));
    }

    const availProviders = i.filter(x => x.available && x.models && x.models.length > 0);
    if (availProviders.length > 0) {
      const firstProv = availProviders[0];
      setSelection(s => ({
        ...s,
        provider: firstProv.provider,
        model: firstProv.models![0],
        apiBase: getProvider(firstProv.provider).baseURL,
      }));
    }

    setStep('planner');
  });

  useEffect(() => { stableDetect(); }, []);

  const finishSetup = useEffectEvent((sel: Selection) => {
    const projectDir = configStore.get().projectDir;
    if (!projectDir) return;

    const config: Config = createDefaultConfig();
    config.planner.tool = sel.planner;
    if (sel.plannerModel) config.planner.model = sel.plannerModel;
    config.implementer.provider = sel.provider;
    config.implementer.model = sel.model;
    config.implementer.apiBase = sel.apiBase ?? getProvider(sel.provider).baseURL ?? config.implementer.apiBase;

    writeConfig(projectDir, config);
    configStore.reload();

    const onComplete = route.screen === 'setup' ? (route as { onComplete?: string }).onComplete : undefined;
    const feature = route.screen === 'setup' ? (route as { feature?: string }).feature : undefined;

    if (onComplete === 'workflow' && feature) {
      routerStore.navigate('workflow', { feature });
    } else {
      routerStore.navigate('home');
    }
  });

  if (step === 'detecting') {
    return (
      <OverlayPanel title="Setup" compact>
        <Box flexDirection="column" alignItems="center" gap={1}>
          <Spinner label="Detecting available tools..." color={t.accent} />
          <Text color={t.textDim}>Scanning for planners and model providers</Text>
        </Box>
      </OverlayPanel>
    );
  }

  if (step === 'done') {
    return (
      <OverlayPanel title="Setup Complete" compact>
        <Box flexDirection="column" gap={1}>
          <Text color={t.success}>✓ Configuration saved</Text>
          <Text color={t.textDim}>Planner: <Text color={t.text}>{selection.planner}</Text></Text>
          <Text color={t.textDim}>Model: <Text color={t.text}>{selection.provider} › {selection.model}</Text></Text>
        </Box>
      </OverlayPanel>
    );
  }

  if (step === 'planner') {
    return (
      <PlannerStep
        planners={planners!}
        selected={selection.planner}
        onSelect={(tool, model) => {
          setSelection(s => ({ ...s, planner: tool, plannerModel: model }));
          setStep('implementer');
        }}
        onCancel={exit}
      />
    );
  }

  return (
    <ImplementerStep
      providers={providers!}
      selected={{ provider: selection.provider, model: selection.model }}
      onSelect={(provider, model, apiBase) => {
        const sel = { ...selection, provider, model, apiBase };
        setSelection(sel);
        setStep('done');
        finishSetup(sel);
      }}
      onBack={() => setStep('planner')}
      onCancel={exit}
    />
  );
}

function plannerTypeLabel(d: PlannerDetection): string {
  return d.type === 'cli' ? 'CLI' : 'API';
}

function PlannerStep({ planners, selected, onSelect, onCancel }: {
  planners: PlannerDetection[];
  selected: PlannerTool;
  onSelect: (tool: PlannerTool, model?: string) => void;
  onCancel: () => void;
}) {
  const t = useTheme();
  const available = planners.filter(p => p.available && p.tool !== 'shell');
  const unavailable = planners.filter(p => !p.available);
  const [rightModels, setRightModels] = useState<KnownModel[]>(() =>
    KNOWN_PLANNER_MODELS[selected] ?? [],
  );

  if (available.length === 0) {
    return (
      <OverlayPanel title="Setup — Planner" hint="Esc quit">
        <Text color={t.warning}>No planner tools detected.</Text>
        <Text color={t.textDim}>Install one of:</Text>
        <Text color={t.text}>  npm i -g @anthropic-ai/claude-code</Text>
        <Text color={t.text}>  npm i -g @openai/codex</Text>
        <Text color={t.textDim}>Then run <Text bold>tiny-spec init</Text> again.</Text>
      </OverlayPanel>
    );
  }

  return (
    <TwoColumnPicker<PlannerDetection, KnownModel>
      title="Setup"
      stepLabel="Choose Planner (1/2)"
      leftLabel="Tools"
      rightLabel="Models"
      leftItems={available}
      rightItems={rightModels}
      leftGetKey={item => item.tool}
      rightGetKey={item => item.name}
      leftFilterFn={(item, q) => item.tool.toLowerCase().includes(q.toLowerCase())}
      rightFilterFn={(item, q) => item.name.toLowerCase().includes(q.toLowerCase())}
      onLeftChange={item => {
        setRightModels(KNOWN_PLANNER_MODELS[item.tool] ?? []);
      }}
      onConfirm={(backend, model) => {
        onSelect(backend.tool, model?.name);
      }}
      onCancel={onCancel}
      leftRenderRow={(item, isCursor) => {
        const isCurrent = item.tool === selected;
        return (
          <Box>
            <Text color={isCursor ? t.accent : t.text} bold={isCursor}>{item.tool}</Text>
            <Text color={t.textDim}>  {plannerTypeLabel(item)}</Text>
            {item.version && <Text color={t.textDim}> v{item.version}</Text>}
            {isCurrent && <Text color={t.success}> {'\u2713'}</Text>}
          </Box>
        );
      }}
      rightRenderRow={(item, isCursor) => {
        return (
          <Box>
            <Text color={isCursor ? t.accent : t.text} bold={isCursor}>{item.name}</Text>
            {item.isDefault && <Text color={t.textDim}> (default)</Text>}
          </Box>
        );
      }}
      rightPlaceholder={unavailable.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={t.textDim} dimColor>  Not installed:</Text>
          {unavailable.map(p => (
            <Text key={p.tool} color={t.textDim} dimColor>    {p.tool}</Text>
          ))}
        </Box>
      ) : undefined}
    />
  );
}

interface BackendItem {
  provider: string;
  isLocal: boolean;
  available: boolean;
  modelCount: number;
}

interface ModelItem {
  model: string;
}

function ImplementerStep({ providers, selected, onSelect, onBack, onCancel }: {
  providers: ProviderDetection[];
  selected: { provider: string; model: string };
  onSelect: (provider: string, model: string, apiBase?: string) => void;
  onBack: () => void;
  onCancel: () => void;
}) {
  const t = useTheme();
  const [selectedProvider, setSelectedProvider] = useState(selected.provider);

  const backends = buildBackendItems(providers).filter(b => b.provider !== 'shell');
  const rightModels = modelsForProvider(providers, selectedProvider);

  if (backends.length === 0 || backends.every(b => !b.available)) {
    return (
      <OverlayPanel title="Setup — Model (2/2)" hint="Esc back">
        <Text color={t.warning}>No models detected.</Text>
        <Box flexDirection="column" marginTop={1}>
          <Text color={t.textDim}>Start a local provider to see models:</Text>
          <Text color={t.text}>  ollama serve</Text>
          <Text color={t.text}>  # or launch LM Studio</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={t.textDim}>Using defaults: <Text color={t.text}>ollama / qwen2.5-coder:7b</Text></Text>
        </Box>
      </OverlayPanel>
    );
  }

  return (
    <TwoColumnPicker<BackendItem, ModelItem>
      title="Setup"
      stepLabel="Choose Model (2/2)"
      leftLabel="Providers"
      rightLabel="Models"
      leftItems={backends}
      rightItems={rightModels}
      leftGetKey={item => item.provider}
      rightGetKey={item => item.model}
      leftFilterFn={(item, q) => item.provider.toLowerCase().includes(q.toLowerCase())}
      rightFilterFn={(item, q) => item.model.toLowerCase().includes(q.toLowerCase())}
      onLeftChange={item => {
        setSelectedProvider(item.provider);
      }}
      onConfirm={(left, right) => {
        const providerDef = getProvider(left.provider);
        const model = right?.model || 'qwen2.5-coder:7b';
        onSelect(left.provider, model, providerDef.baseURL);
      }}
      onCancel={onBack}
      leftRenderRow={(item, isCursor) => {
        const locality = item.isLocal ? 'local, free' : 'remote';
        const isCurrent = item.provider === selected.provider;
        return (
          <Box>
            <Text color={isCursor ? t.accent : t.text} bold={isCursor}>{item.provider}</Text>
            <Text color={t.textDim}>  {locality}</Text>
            {isCurrent && <Text color={t.success}> {'\u2713'}</Text>}
          </Box>
        );
      }}
      rightRenderRow={(item, isCursor) => {
        const isCurrent = item.model === selected.model;
        return (
          <Box>
            <Text color={isCursor ? t.accent : t.text} bold={isCursor}>{item.model}</Text>
            {isCurrent && <Text color={t.success}> {'\u2713'}</Text>}
          </Box>
        );
      }}
    />
  );
}
