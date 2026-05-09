import { useEffect } from 'react';
import { Text } from 'ink';
import { beforeEach, describe, expect, it } from 'vitest';
import { configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/project/detection.js';
import { modelCacheStore } from '../../stores/discovery/model-cache.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { usePickerCatalog } from './use-picker-catalog.js';
import { makeConfig } from '#testing/helpers/factories/config.js';

function CatalogProbe({
  role,
  selectItemId,
}: {
  role: 'planner' | 'implementer';
  selectItemId?: string | undefined;
}) {
  const catalog = usePickerCatalog(role, 0);

  useEffect(() => {
    if (!selectItemId) return;
    const item = catalog.items.find(candidate => candidate.id === selectItemId);
    if (item) catalog.setCurrentItem(item);
  }, [selectItemId]);

  return <Text>{role}:{catalog.currentItem?.id ?? 'none'}</Text>;
}

describe('usePickerCatalog', () => {
  beforeEach(() => {
    configStore.__testReset({ projectDir: '/tmp/project', config: makeConfig() });
    detectionStore.reset();
    modelCacheStore.reset();
    overlayStore.reset();
  });

  it('does not carry current tool selection from planner to implementer', async () => {
    const ui = renderFeature(<CatalogProbe role="planner" selectItemId="claude-code" />);
    await tick(20);
    expect(ui.lastFrame()).toContain('planner:claude-code');

    ui.rerender(<CatalogProbe role="implementer" />);
    await tick(20);

    expect(ui.lastFrame()).toContain('implementer:ollama');
    ui.unmount();
  });
});
