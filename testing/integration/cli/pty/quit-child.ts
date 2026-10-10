import '../../../../src/node-env.js';
import { createElement } from 'react';
import { Text, useApp } from 'ink';
import { useAppKeys } from '../../../../src/app/keys.js';
import { renderApp } from '../../../../src/cli/render/app.js';
import { getDefaultDetectionService } from '../../../../src/engine/detection/service.js';
import { feedbackStore } from '../../../../src/stores/ui/feedback.js';

function QuitFixture() {
  const { exit } = useApp();
  useAppKeys({ exit });
  const feedback = feedbackStore.use((state) => state.message);
  return createElement(Text, null, feedback ?? 'Quit discovery pending');
}

const discovery = getDefaultDetectionService().loadDetection({
  deps: {
    detectAll: async () => ({ providers: [], cliTools: [] }),
    discoverAllCliTools: async () => [],
    fetchModelsDevCatalog: () =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              kind: 'fresh',
              snapshot: {
                sourceUrl: 'https://models.dev/api.json',
                parserVersion: 'test-parser',
                catalog: Object.freeze({}),
                catalogState: 'empty',
                fetchedAt: 1_700_000_000_000,
                validatedAt: 1_700_000_000_000,
              },
            }),
          60_000,
        ),
      ),
  },
});

await Promise.all([
  discovery,
  renderApp(createElement(QuitFixture), {
    fullscreen: true,
    mouse: false,
    unmountSignal: new AbortController().signal,
  }),
]);
