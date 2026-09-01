import { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { SOFT_SEP } from '../../components/separators.js';
import { useTheme } from '../../components/theme.js';
import type { ActiveRunnerRole } from '../../core/runners/seat-roles.js';
import { glyph } from '../../lib/glyphs.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { OverlayPanel } from '../../components/overlays/overlay-panel.js';
import { ContractChip, StepIndicator, tierColor } from './contract-chip.js';
import {
  contractForRunnerKind,
  type CustomCommandRunnerKind,
} from '../../core/config/custom-commands.js';
import { overlayAllowsPickerKeys } from '../../core/navigation/types.js';

interface ContractCard {
  kind: CustomCommandRunnerKind;
  title: string;
  resultClause: string;
  filesClause: string;
}

const CONTRACT_CARDS: readonly ContractCard[] = [
  {
    kind: 'shell',
    title: 'Output command',
    resultClause: "read from the command's stdout",
    filesClause: 'no direct writes',
  },
  {
    kind: 'agent',
    title: 'Direct-write agent',
    resultClause: 'the files it writes, not stdout',
    filesClause: 'written directly to your tree',
  },
];

const LEDGER_INDENT = ' '.repeat(9);

function ContractCardView({
  card,
  focused,
  configured,
}: {
  card: ContractCard;
  focused: boolean;
  configured: boolean;
}) {
  const t = useTheme();
  const tier = contractForRunnerKind(card.kind);
  const color = tierColor(t, tier);
  /** The bar marks one row, so only the card's first row carries it. */
  const lead = (first: boolean) => {
    if (!first) return <Text color={t.textDim}>{'  '}</Text>;
    return focused ? (
      <Text color={color}>{`${glyph('liveBar')} `}</Text>
    ) : (
      <Text color={t.textDim}>{'· '}</Text>
    );
  };
  return (
    <Box flexDirection="column">
      <Box height={1} overflow="hidden">
        <Box flexShrink={0}>
          {lead(true)}
          <ContractChip tier={tier} solid={focused} />
        </Box>
        <Box flexGrow={1} minWidth={0} overflow="hidden">
          <Text color={t.text} wrap="truncate-end">{` ${card.title}`}</Text>
        </Box>
        <Box flexShrink={0}>
          <Text color={t.textDim}>{` ${card.kind}`}</Text>
          {configured ? <Text color={t.success}>{` ${glyph('check')}`}</Text> : <Text>{'  '}</Text>}
        </Box>
      </Box>
      <Box height={1} overflow="hidden">
        <Box flexShrink={0}>
          {lead(false)}
          <Text color={t.textDim}>{`${LEDGER_INDENT}result${SOFT_SEP}`}</Text>
        </Box>
        <Box flexGrow={1} minWidth={0} overflow="hidden">
          <Text color={t.textDim} wrap="truncate-end">
            {card.resultClause}
          </Text>
        </Box>
      </Box>
      <Box height={1} overflow="hidden">
        <Box flexShrink={0}>
          {lead(false)}
          <Text color={t.textDim}>{`${LEDGER_INDENT}files ${SOFT_SEP}`}</Text>
        </Box>
        <Box flexGrow={1} minWidth={0} overflow="hidden">
          <Text color={color} wrap="truncate-end">
            {card.filesClause}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

interface ContractChoiceOverlayProps {
  role: ActiveRunnerRole;
  initialKind?: CustomCommandRunnerKind | undefined;
  configuredKind?: CustomCommandRunnerKind | undefined;
  onChoose: (kind: CustomCommandRunnerKind) => void;
}

export function ContractChoiceOverlay({
  role,
  initialKind,
  configuredKind,
  onChoose,
}: ContractChoiceOverlayProps) {
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      CONTRACT_CARDS.findIndex((card) => card.kind === initialKind),
    ),
  );
  const focus = overlayStore.use((s) => overlayAllowsPickerKeys(s.active));

  useEffect(() => {
    overlayStore.setExclusive(true);
    return () => {
      overlayStore.setExclusive(false);
    };
  }, []);

  useInput(
    (_input, key) => {
      if (key.upArrow) setIndex((current) => Math.max(0, current - 1));
      if (key.downArrow) setIndex((current) => Math.min(CONTRACT_CARDS.length - 1, current + 1));
      if (key.return) {
        const card = CONTRACT_CARDS[index];
        if (card) onChoose(card.kind);
      }
    },
    { isActive: focus },
  );

  return (
    <OverlayPanel
      density="roomy"
      title={`Custom command${SOFT_SEP}${role}`}
      hint={`↑↓ select${SOFT_SEP}⏎ continue${SOFT_SEP}esc back`}
    >
      <Box marginBottom={1}>
        <StepIndicator active="contract" />
      </Box>
      {CONTRACT_CARDS.map((card, cardIndex) => (
        <Box key={card.kind} flexDirection="column" marginTop={cardIndex === 0 ? 0 : 1}>
          <ContractCardView
            card={card}
            focused={cardIndex === index}
            configured={card.kind === configuredKind}
          />
        </Box>
      ))}
    </OverlayPanel>
  );
}
