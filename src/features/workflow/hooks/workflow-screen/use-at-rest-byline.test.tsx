import { renderToString, Text } from 'ink';
import { afterEach, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { makeView } from '#testing/helpers/factories/summary-view.js';
import { renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { configStore } from '../../../../stores/project/config.js';
import { departureStore } from '../../../../stores/workflow/departure.js';
import { useAtRestByline } from './use-at-rest-byline.js';

function FinishingApply() {
  const { byline } = useAtRestByline({
    model: {
      applying: true,
      atRestRecord: makeRunRecord({ status: { kind: 'closed', as: 'applied' } }),
      closedView: makeView({ outcome: { kind: 'applied' } }),
      continuable: false,
      observing: false,
      inputHint: '',
    },
    cols: 120,
    closed: true,
    confirming: false,
    scrollAboveLabel: '',
    scrollBelowLabel: '',
  });
  return <Text>{byline?.map((part) => part.text).join('')}</Text>;
}

afterEach(resetAllStores);

it('requires config to be loaded before rendering the workflow byline', () => {
  expect(() => renderToString(<FinishingApply />)).toThrow(
    'configStore.load must be called before rendering',
  );
});

it.each([null, 'quit'] as const)(
  'shows cleanup until Apply releases the checkout with departure %s',
  (queued) => {
    configStore.__testReset({ projectDir: '/tmp/project', config: makeConfig() });
    if (queued !== null) departureStore.queue({ kind: queued, run: () => {} });
    const ui = renderFeature(<FinishingApply />);
    const line = ui.lastFrame();
    ui.unmount();
    expect(line).toMatch(/cleanup/i);
    expect(line).not.toMatch(/applying to your checkout|\/run reject/i);
    if (queued === 'quit') expect(line).toMatch(/quit/i);
  },
);
