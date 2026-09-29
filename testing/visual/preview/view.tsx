import { Box, Text, useInput } from 'ink';
import * as React from 'react';
import { useEffect, useState, type ReactNode } from 'react';
import { App, type AppProps } from '../../../src/app/root.js';
import { feedbackStore } from '../../../src/stores/ui/feedback.js';
import { truncateTerminalDisplayText } from '../../../src/utils/display-text.js';
import { formatViewport, type Viewport } from '../contracts/geometry.js';
import type { FixtureWrite } from '../fixtures/common.js';
import type { PreviewController, PreviewSession, PreviewState } from './controller.js';

export interface PreviewViewProps {
  readonly controller: PreviewController;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function selectedScenario(state: PreviewState) {
  return state.scenarios[state.scenarioIndex];
}

function selectedViewport(state: PreviewState): Viewport | undefined {
  return selectedScenario(state)?.viewports[state.viewportIndex];
}

function line(state: PreviewState, text: string): string {
  return truncateTerminalDisplayText(text, Math.max(1, state.hostViewport.cols - 2));
}

function visibleScenarioIndexes(state: PreviewState): readonly number[] {
  const rowBudget = Math.max(1, state.hostViewport.rows - 10);
  const start = Math.max(
    0,
    Math.min(state.scenarioIndex - Math.floor(rowBudget / 2), state.scenarios.length - rowBudget),
  );
  const end = Math.min(state.scenarios.length, start + rowBudget);
  return Array.from({ length: end - start }, (_, offset) => start + offset);
}

function ScenarioChooser({ state }: { readonly state: PreviewState }): ReactNode {
  const scenario = selectedScenario(state);
  const declared = selectedViewport(state);
  if (scenario === undefined || declared === undefined) return null;

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text bold color="cyan">
        TUI gallery preview
      </Text>
      <Text wrap="truncate-end">
        {line(
          state,
          `${state.scenarios.length} scenarios · terminal ${formatViewport(state.hostViewport)}`,
        )}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {visibleScenarioIndexes(state).map((index) => {
          const candidate = state.scenarios[index];
          if (candidate === undefined) return null;
          const selected = index === state.scenarioIndex;
          return (
            <Text key={candidate.id} wrap="truncate-end" {...(selected ? { color: 'cyan' } : {})}>
              {line(state, `${selected ? '› ' : '  '}${candidate.id} · ${candidate.title}`)}
            </Text>
          );
        })}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text wrap="truncate-end">
          {line(state, `Selected: ${scenario.id} · viewport ${formatViewport(declared)}`)}
        </Text>
        {state.message === null ? (
          <Text dimColor wrap="truncate-end">
            {line(state, 'Ready to open this scenario.')}
          </Text>
        ) : (
          <Text color="yellow" wrap="truncate-end">
            {line(state, state.message)}
          </Text>
        )}
      </Box>
      <Text dimColor wrap="truncate-end">
        {line(state, '↑↓ choose · Enter open · F2 back · F5 reset')}
      </Text>
      <Text dimColor wrap="truncate-end">
        {line(state, 'F6 viewport · Ctrl+Q quit')}
      </Text>
    </Box>
  );
}

function LoadingView({ state }: { readonly state: PreviewState }): ReactNode {
  const scenario = selectedScenario(state);
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text color="cyan" wrap="truncate-end">
        {line(state, `Opening ${scenario?.id ?? 'scenario'}…`)}
      </Text>
      <Text dimColor wrap="truncate-end">
        {line(state, 'F2 returns to the gallery selection · Ctrl+Q quits.')}
      </Text>
    </Box>
  );
}

function renderPreview(session: PreviewSession): ReactNode {
  return React.createElement<AppProps>(App, session.props);
}

export function PreviewView({ controller }: PreviewViewProps): ReactNode {
  const [state, setState] = useState(controller.getState);
  const session = state.kind === 'preview' ? state.session : undefined;

  useEffect(() => controller.subscribe(() => setState(controller.getState())), [controller]);

  useEffect(() => {
    if (session === undefined) return;
    const write: FixtureWrite = Object.assign(
      (input: string) => controller.forwardToPreview(input),
      { press: controller.pressToPreview },
    );
    void session.activate(write).catch((error: unknown) => {
      feedbackStore.setError('Preview activation failed: ' + errorMessage(error));
    });
  }, [controller, session]);

  useInput((_input, key) => {
    if (state.kind !== 'chooser') return;
    if (key.upArrow) {
      controller.moveSelection(-1);
      return;
    }
    if (key.downArrow) {
      controller.moveSelection(1);
      return;
    }
    if (key.return) {
      void controller.activateSelection();
      return;
    }
    if (key.leftArrow || key.rightArrow) void controller.selectViewport();
  });

  if (state.kind === 'chooser') {
    return <ScenarioChooser state={state} />;
  }
  if (state.kind === 'loading') return <LoadingView state={state} />;
  return renderPreview(state.session);
}
