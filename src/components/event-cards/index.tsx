import React from 'react';
import { Box, Text } from 'ink';
import type { TuiEvent } from '../../types.js';
import type { Theme } from '../../ui/theme.js';
import { useTheme } from '../../ui/theme.js';
import { PlannerText } from '../../ui/markdown.js';
import { Spinner } from '../../ui/spinner.js';
import { formatDuration } from '../../utils/format.js';
import { Card } from './card.js';
import { ImplementerCard } from './implementer-card.js';
import { ValidateCard } from './validate-card.js';

const IMPLEMENTER_PHASES: ReadonlySet<string> = new Set(['implementing', 'validating-task']);

function phaseRole(phase: string): 'planner' | 'implementer' {
  return IMPLEMENTER_PHASES.has(phase) ? 'implementer' : 'planner';
}

interface EventCardProps {
  event: TuiEvent;
  diffExpanded?: boolean;
}

type RenderCtx = {
  t: Theme;
  diffExpanded: boolean;
};

type EventRenderer<K extends TuiEvent['type']> =
  (e: Extract<TuiEvent, { type: K }>, ctx: RenderCtx) => React.ReactNode;

const RENDERERS: { [K in TuiEvent['type']]: EventRenderer<K> } = {
  'planner-status':      (e, { t }) => {
    const role = phaseRole(e.phase);
    const color = role === 'implementer' ? t.implementer : t.planner;
    if (e.status === 'running') {
      return <Spinner label={`${role}  ${e.phase}...`} color={color} startTime={e.ts} />;
    }
    const dur = e.duration ? ` ${formatDuration(e.duration)}` : '';
    return (
      <Text>
        <Text color={color}>{role}</Text>
        <Text color={t.success}>  ✓ {e.phase}</Text>
        <Text color={t.textDim}>{dur}</Text>
        {e.summary && <Text color={t.textDim}>  {e.summary}</Text>}
      </Text>
    );
  },
  'planner-text':        e => <PlannerText text={e.text} />,
  'task-start':          (e, { t }) => <Card label={<Text bold>T{e.index + 1}: {e.title}</Text>} value={`${e.file} (${e.action})`} valueColor={t.textDim} />,
  'task-complete':       () => null,
  'task-skipped':        (e, { t }) => <Card label="skipped" labelColor={t.textDim} value={`T${e.taskId} ${e.title}: ${e.reason}`} valueColor={t.textDim} />,
  'implementer-generate': (e, { diffExpanded }) => <ImplementerCard event={e} diffExpanded={diffExpanded} />,
  'validate':            e => <ValidateCard event={e} />,
  'retry':               (e, { t }) => <Card label="retry" labelColor={t.warning} value={`attempt ${e.attempt}/${e.maxRetries}`} valueColor={t.textDim} />,
  'escalate':            (e, { t }) => (
    <Box flexDirection="column">
      <Box>
        <Text color={t.planner} bold>escalate </Text>
        <Text color={t.textDim}>tier {e.tier}</Text>
        {e.hint && <Text color={t.textDim}> — hint</Text>}
      </Box>
      {e.hint && (
        <Box marginLeft={2}>
          <Text color={t.textDim}>{e.hint}</Text>
        </Box>
      )}
    </Box>
  ),
  'git-commit':          (e, { t }) => <Card label="committed" labelColor={t.success} value={e.message} valueColor={t.textDim} />,
  'git-checkpoint':      (e, { t }) => <Card label="checkpoint" labelColor={t.success} value={e.tag} valueColor={t.textDim} />,
  'warning':             (e, { t }) => <Card label="warning" labelColor={t.warning} value={e.message} valueColor={t.warning} />,
  'error':               (e, { t }) => <Card label="error" labelColor={t.error} value={e.message} valueColor={t.error} />,
  'cost-update':         () => null,
  'workflow-cancelled':  (_, { t }) => (
    <Box flexDirection="column">
      <Text color={t.warning} bold>Workflow cancelled</Text>
      <Text color={t.textDim}>Resume with: <Text color={t.text}>tiny-spec resume</Text></Text>
    </Box>
  ),
};

function getGutterRole(event: TuiEvent): 'planner' | 'implementer' | null {
  switch (event.type) {
    case 'planner-status':
      return phaseRole(event.phase);
    case 'planner-text':
    case 'task-start':
      return 'planner';
    case 'implementer-generate':
    case 'validate':
    case 'git-commit':
    case 'git-checkpoint':
    case 'retry':
      return 'implementer';
    case 'escalate':
      return 'planner';
    case 'warning':
    case 'error':
    case 'task-complete':
    case 'task-skipped':
    case 'cost-update':
    case 'workflow-cancelled':
      return null;
  }
}

export default function EventCard({ event, diffExpanded }: EventCardProps) {
  const t = useTheme();
  const render = RENDERERS[event.type] as EventRenderer<typeof event.type>;
  const ctx: RenderCtx = { t, diffExpanded: diffExpanded ?? false };
  const content = render(event as Extract<TuiEvent, { type: typeof event.type }>, ctx);
  if (!content) return null;

  const role = getGutterRole(event);
  if (!role) return <>{content}</>;
  const color = role === 'implementer' ? t.implementer : t.planner;
  const char = role === 'implementer' ? '┆' : '│';
  const indent = role === 'implementer' ? '  ' : '';
  return (
    <Box flexDirection="row">
      <Text color={color}>{indent}{char} </Text>
      <Box flexDirection="column" flexGrow={1}>{content}</Box>
    </Box>
  );
}
