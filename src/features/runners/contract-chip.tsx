import { Box, Text } from 'ink';
import { SOFT_SEP } from '../../components/separators.js';
import { useTheme, type Theme } from '../../components/theme.js';
import { glyph } from '../../lib/glyphs.js';
import type { CustomCommandContract } from '../../core/config/custom-commands.js';

export function tierColor(t: Theme, tier: CustomCommandContract): string {
  return tier === 'output' ? t.info : t.warning;
}

export function ContractChip({ tier, solid }: { tier: CustomCommandContract; solid: boolean }) {
  const t = useTheme();
  return (
    <Text color={tierColor(t, tier)} inverse={solid}>
      {tier === 'output' ? ' OUTPUT ' : ' DIRECT '}
    </Text>
  );
}

export function ContractRecap({ tier }: { tier: CustomCommandContract }) {
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
