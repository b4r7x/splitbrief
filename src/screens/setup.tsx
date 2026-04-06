import { useState, useEffect } from 'react';
import { Box, Text, useApp } from 'ink';
import { useTheme } from '../ui/theme.js';
import { OverlayPanel } from '../ui/overlay-panel.js';
import { Spinner } from '../ui/spinner.js';
import { ToolModelPicker } from '../components/tool-model-picker.js';
import { routerStore } from '../stores/router.js';
import { configStore } from '../stores/config.js';
import { detectionStore } from '../stores/detection.js';
import { writeConfig } from '../core/config.js';
import type { Config } from '../types.js';

type Step = 'detecting' | 'no-planners' | 'planner' | 'implementer';

export function SetupScreen() {
  const t = useTheme();
  const { exit } = useApp();
  const route = routerStore.use(s => s);

  const planners = detectionStore.use(s => s.planners);
  const implementers = detectionStore.use(s => s.implementers);
  const loading = detectionStore.use(s => s.loading);

  const [step, setStep] = useState<Step>('detecting');

  useEffect(() => {
    if (!planners && !loading) {
      detectionStore.load();
    }
  }, [planners, loading]);

  useEffect(() => {
    if (step !== 'detecting' || !planners || !implementers) return;
    const availablePlanners = planners.filter(p => p.available);
    setStep(availablePlanners.length === 0 ? 'no-planners' : 'planner');
  }, [step, planners, implementers]);

  const finalize = (finalConfig: Config) => {
    const projectDir = configStore.get().projectDir;
    if (!projectDir) return;
    writeConfig(projectDir, finalConfig);
    configStore.reload();
    const onComplete = route.screen === 'setup' ? route.onComplete : undefined;
    const feature = route.screen === 'setup' ? route.feature : undefined;
    if (onComplete === 'workflow' && feature) {
      routerStore.navigate('workflow', { feature });
    } else {
      routerStore.navigate('home');
    }
  };

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

  if (step === 'no-planners') {
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

  if (step === 'planner') {
    return (
      <ToolModelPicker
        role="planner"
        stepLabel="Choose Planner (1/2)"
        onConfirm={(updated) => {
          configStore.save(updated);
          setStep('implementer');
        }}
        onCancel={exit}
      />
    );
  }

  return (
    <ToolModelPicker
      role="implementer"
      stepLabel="Choose Model (2/2)"
      onConfirm={finalize}
      onCancel={() => setStep('planner')}
    />
  );
}
