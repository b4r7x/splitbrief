import { useState } from 'react';
import { Text, useApp } from 'ink';
import { useTheme } from '../ui/theme.js';
import { OverlayPanel } from '../components/overlays/overlay-panel.js';
import { ToolModelPicker } from '../components/overlays/tool-model-picker/picker.js';
import { routerStore } from '../stores/router.js';
import { configStore } from '../stores/config.js';
import { detectionStore } from '../stores/detection.js';
import { useStores } from '../stores/use-stores.js';
import type { Config } from '../types.js';

type Step = 'no-planners' | 'planner' | 'implementer';

export function SetupScreen() {
  const t = useTheme();
  const { exit } = useApp();
  const [{ planners }, { projectDir }] = useStores(detectionStore, configStore);
  const onComplete = routerStore.use(s => s.screen === 'setup' ? s.onComplete : undefined);
  const pendingFeature = routerStore.use(s => s.screen === 'setup' ? s.feature : undefined);

  const [step, setStep] = useState<Step>(() =>
    planners.filter(p => p.available).length === 0 ? 'no-planners' : 'planner',
  );

  const finalize = (finalConfig: Config) => {
    if (!projectDir) return;
    const saved = configStore.save(finalConfig);
    if (!saved) return;
    if (onComplete === 'workflow' && pendingFeature) {
      routerStore.navigate('workflow', { feature: pendingFeature });
    } else {
      routerStore.navigate('home');
    }
  };

  if (step === 'no-planners') {
    return (
      <OverlayPanel title="Setup — Planner" hint="Esc quit">
        <Text color={t.warning}>No planner tools detected.</Text>
        <Text color={t.textDim}>Install one of:</Text>
        <Text color={t.text}>  npm i -g @anthropic-ai/claude-code</Text>
        <Text color={t.text}>  npm i -g @openai/codex</Text>
        <Text color={t.textDim}>Then run <Text bold>diptych init</Text> again.</Text>
      </OverlayPanel>
    );
  }

  if (step === 'planner') {
    return (
      <ToolModelPicker
        role="planner"
        stepLabel="Choose Planner (1/2)"
        onConfirm={(updated) => {
          const saved = configStore.save(updated);
          if (saved) setStep('implementer');
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
