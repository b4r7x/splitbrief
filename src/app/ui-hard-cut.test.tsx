import { Box, Text } from 'ink';
import { afterEach, expect, it, vi } from 'vitest';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePlannerText } from '#testing/helpers/events/planner.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { Composer } from '../components/composer/composer.js';
import { getHomeLayout } from '../features/home/layout.js';
import { getLogo } from '../features/home/logo.js';
import { ConversationFlow } from '../features/workflow/components/conversation-flow/flow.js';
import { InputFooter } from '../features/workflow/components/input-footer.js';
import { configStore } from '../stores/project/config.js';
import { routerStore } from '../stores/navigation/router.js';
import { eventsStore } from '../stores/workflow/events.js';
import { lifecycleStore } from '../stores/workflow/lifecycle.js';
import { overlayStore } from '../stores/ui/overlay.js';
import { terminalSizeStore } from '../stores/ui/terminal-size.js';
import { Layout } from './layout.js';
import { HomeScreen } from './screens/home.js';

function NavigationReturnHarness() {
  const route = routerStore.use((state) => state);
  const activeOverlay = overlayStore.use((state) => state.active);

  return (
    <Layout
      screen={
        <Box flexDirection="column" height={12} justifyContent="flex-end">
          <Composer
            commands={[]}
            currentScreen={route.screen}
            mode="normal"
            hint=""
            onSubmit={() => {}}
            onRuntimeCommand={() => {}}
          />
        </Box>
      }
      overlay={
        activeOverlay === 'none' ? null : (
          <Box>
            <Text>{activeOverlay}</Text>
          </Box>
        )
      }
    />
  );
}

afterEach(() => {
  resetAllStores();
});

const cases: ReadonlyArray<{
  label: string;
  verify: () => void | Promise<void>;
}> = [
  {
    label: 'identity',
    verify: async () => {
      configStore.__testReset({ projectDir: '/tmp/splitbrief-ui', config: makeConfig() });
      routerStore.init({ screen: 'home' });
      terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: false });

      const ui = renderFeature(<HomeScreen commands={[]} onRuntimeCommand={() => {}} />);
      await flushEffects();

      const frame = ui.lastFrame() ?? '';
      const layout = getHomeLayout({ cols: 80, rows: 24 });
      for (const line of getLogo(layout.logoTier).split('\n')) {
        expect(frame).toContain(line.trim());
      }
      ui.unmount();
    },
  },
  {
    label: 'composer-command',
    verify: async () => {
      configStore.__testReset({ projectDir: '/tmp/splitbrief-ui', config: makeConfig() });
      terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: false });
      const runtimeCommands: string[] = [];
      const prompts: string[] = [];
      const ui = renderFeature(
        <Box flexDirection="column" height={12} justifyContent="flex-end">
          <Composer
            commands={[
              {
                kind: 'noarg',
                name: '/help',
                label: 'Help',
                description: 'Show help',
                category: 'navigate',
                validScreens: ['home'],
                handler: () => {},
              },
            ]}
            currentScreen="home"
            mode="normal"
            hint=""
            onSubmit={(prompt) => prompts.push(prompt)}
            onRuntimeCommand={(command) => runtimeCommands.push(command)}
          />
        </Box>,
      );

      await flushEffects();
      ui.stdin.write('/help');
      await vi.waitFor(() => expect(ui.lastFrame() ?? '').toContain('/help'));
      await flushEffects();
      ui.stdin.write('\r');
      await vi.waitFor(() => expect(runtimeCommands).toEqual(['/help']));

      expect(prompts).toEqual([]);
      ui.unmount();
    },
  },
  {
    label: 'byline-not-row',
    verify: () => {
      configStore.__testReset({ projectDir: '/tmp/splitbrief-ui', config: makeConfig() });
      routerStore.init({
        screen: 'workflow',
        execution: {
          kind: 'attached',
          feature: 'preserve status placement',
          sessionId: 'attached-session',
          attach: { sockPath: '/tmp/splitbrief.sock', authToken: 'test-token' },
        },
      });
      terminalSizeStore.__testReset({ cols: 100, rows: 30, isSmall: false });
      eventsStore.__testReset({
        events: [
          makePlannerText({
            phase: 'researching',
            text: 'Transcript remains separate from live status.',
          }),
        ],
      });
      lifecycleStore.__testReset({
        phase: 'researching',
        status: 'running',
        startedAt: Date.now() - 1_000,
        phaseFirstSeenTs: { researching: Date.now() - 1_000 },
      });

      const transcript = renderFeature(
        <ConversationFlow height={8} conversationWidth={80} contentWidth={80} />,
      );
      const byline = renderFeature(<InputFooter width={80} />);

      expect(transcript.lastFrame() ?? '').toContain(
        'Transcript remains separate from live status.',
      );
      expect(transcript.lastFrame() ?? '').not.toContain('Researching…');
      expect(byline.lastFrame() ?? '').toContain('Researching…');

      transcript.unmount();
      byline.unmount();
    },
  },
  {
    label: 'navigation-return',
    verify: async () => {
      configStore.__testReset({ projectDir: '/tmp/splitbrief-ui', config: makeConfig() });
      terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: false });
      routerStore.init({
        screen: 'workflow',
        execution: {
          kind: 'attached',
          feature: 'preserve route state',
          sessionId: 'preserve-session',
          attach: { sockPath: '/tmp/preserve.sock', authToken: 'keep-this-token' },
        },
      });
      const origin = routerStore.get();
      const ui = renderFeature(<NavigationReturnHarness />);
      await flushEffects();

      ui.stdin.write('draft survives overlays');
      await vi.waitFor(() => {
        expect(ui.lastFrame() ?? '').toContain('draft survives overlays');
      });

      overlayStore.open('help', 'help-search');
      await vi.waitFor(() => {
        expect(ui.lastFrame() ?? '').toContain('help');
        expect(ui.lastFrame() ?? '').not.toContain('draft survives overlays');
      });

      overlayStore.open('command-palette', 'palette-query');
      await vi.waitFor(() => {
        expect(ui.lastFrame() ?? '').toContain('command-palette');
      });

      overlayStore.close();
      await vi.waitFor(() => {
        expect(ui.lastFrame() ?? '').toContain('help');
      });
      expect(overlayStore.get()).toMatchObject({
        active: 'help',
        focus: 'help-search',
      });

      overlayStore.close();
      await vi.waitFor(() => {
        expect(ui.lastFrame() ?? '').toContain('draft survives overlays');
      });

      await flushEffects();
      ui.stdin.write(' and focus resumes');
      await vi.waitFor(() => {
        expect(ui.lastFrame() ?? '').toContain('draft survives overlays and focus resumes');
      });

      expect(overlayStore.get()).toMatchObject({ active: 'none', stack: [] });
      expect(routerStore.get()).toEqual(origin);
      ui.unmount();
    },
  },
];

it.each(cases)('$label', async ({ verify }) => {
  resetAllStores();
  await verify();
});
