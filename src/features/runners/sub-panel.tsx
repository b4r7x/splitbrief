import type { ReactElement, ReactNode } from 'react';
import { Box, Text } from 'ink';
import { SOFT_SEP } from '../../components/separators.js';
import { useTheme, type Theme } from '../../components/theme.js';
import type { ActiveRunnerRole } from '../../core/runners/cli-tool-catalog.js';
import { borderStyleFor, glyph } from '../../lib/glyphs.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { subPanelWidth } from './panel-width.js';

export type ContractTier = 'output' | 'direct';

export function contractTierOf(kind: 'shell' | 'agent'): ContractTier {
  return kind === 'shell' ? 'output' : 'direct';
}

export function tierColor(t: Theme, tier: ContractTier): string {
  return tier === 'output' ? t.info : t.warning;
}

export function ContractChip({ tier, solid }: { tier: ContractTier; solid: boolean }) {
  const t = useTheme();
  return (
    <Text color={tierColor(t, tier)} inverse={solid}>
      {tier === 'output' ? ' OUTPUT ' : ' DIRECT '}
    </Text>
  );
}

export function ContractRecap({ tier }: { tier: ContractTier }) {
  const t = useTheme();
  const color = tierColor(t, tier);
  const digest =
    tier === 'output'
      ? ` ${glyph('connectorHandoff')} result from stdout${SOFT_SEP}no direct writes`
      : ` ${glyph('connectorHandoff')} writes files directly${SOFT_SEP}stdout ignored`;
  return (
    <Box height={1} overflow="hidden">
      <Box flexShrink={0}>
        <Text color={color}>{`${glyph('liveBar')} `}</Text>
        <ContractChip tier={tier} solid />
      </Box>
      <Box flexGrow={1} minWidth={0} overflow="hidden">
        <Text color={color} wrap="truncate-end">
          {digest}
        </Text>
      </Box>
    </Box>
  );
}

export function StepIndicator({ active }: { active: 'contract' | 'command' }) {
  const t = useTheme();
  const onCommand = active === 'command';
  return (
    <Box flexShrink={0}>
      <Text color={onCommand ? t.success : t.accent}>
        {onCommand ? glyph('stageDone') : glyph('stageActive')}
      </Text>
      <Text color={onCommand ? t.textDim : t.text}>{' contract '}</Text>
      <Text color={t.textDim}>{glyph('divider')}</Text>
      <Text color={onCommand ? t.accent : t.textDim}>
        {` ${onCommand ? glyph('stageActive') : glyph('stagePending')}`}
      </Text>
      <Text color={onCommand ? t.text : t.textDim}> command</Text>
    </Box>
  );
}

interface SubPanelProps {
  title: string;
  role: ActiveRunnerRole;
  stepIndicator?: ReactElement | undefined;
  hint: string;
  children: ReactNode;
}

export function SubPanel({ title, role, stepIndicator, hint, children }: SubPanelProps) {
  const t = useTheme();
  const cols = terminalSizeStore.use((s) => s.cols);
  const rows = terminalSizeStore.use((s) => s.rows);
  const isSmall = terminalSizeStore.use((s) => s.isSmall);
  return (
    <Box width={cols} height={rows} alignItems="center" justifyContent="center">
      <Box
        flexDirection="column"
        width={subPanelWidth(cols, isSmall)}
        borderStyle={borderStyleFor('round')}
        borderColor={t.border}
        paddingX={1}
      >
        <Box height={1} justifyContent="space-between" overflow="hidden">
          <Box flexShrink={1} minWidth={0} overflow="hidden">
            <Text color={t.accent} wrap="truncate-end">
              {title}
            </Text>
            <Text color={t.textDim}>{`${SOFT_SEP}${role}`}</Text>
          </Box>
          {stepIndicator ? <Box marginLeft={1}>{stepIndicator}</Box> : null}
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {children}
        </Box>
        <Box
          borderStyle={borderStyleFor('single')}
          borderColor={t.border}
          borderTop
          borderBottom={false}
          borderLeft={false}
          borderRight={false}
        >
          <Text color={t.textDim} wrap="truncate-end">
            {hint}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
