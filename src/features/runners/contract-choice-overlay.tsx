import { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { SOFT_SEP } from '../../components/separators.js';
import { useTheme } from '../../components/theme.js';
import type { ActiveRunnerRole } from '../../core/runners/cli-tool-catalog.js';
import { glyph } from '../../lib/glyphs.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { ContractChip, StepIndicator, SubPanel, contractTierOf, tierColor } from './sub-panel.js';
import { overlayAllowsPickerKeys } from '../../core/navigation/types.js';

export type CustomCommandContract = 'shell' | 'agent';

interface ContractCard {
  kind: CustomCommandContract;
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
  const tier = contractTierOf(card.kind);
  const color = tierColor(t, tier);
  const lead = (first: boolean) =>
    focused ? (
      <Text color={color}>{`${glyph('liveBar')} `}</Text>
    ) : (
      <Text color={t.textDim}>{first ? '· ' : '  '}</Text>
    );
  return (
    <Box flexDirection="column">
      <Box height={1} overflow="hidden">
        {lead(true)}
        <ContractChip tier={tier} solid={focused} />
        <Box flexGrow={1} minWidth={0} overflow="hidden">
          <Text color={t.text} wrap="truncate-end">{` ${card.title}`}</Text>
        </Box>
        <Box flexShrink={0}>
          <Text color={t.textDim}>{` ${card.kind}`}</Text>
          {configured ? <Text color={t.success}>{` ${glyph('check')}`}</Text> : null}
        </Box>
      </Box>
      <Box height={1} overflow="hidden">
        {lead(false)}
        <Text color={t.textDim}>{`${LEDGER_INDENT}result${SOFT_SEP}`}</Text>
        <Box flexGrow={1} minWidth={0} overflow="hidden">
          <Text color={t.textDim} wrap="truncate-end">
            {card.resultClause}
          </Text>
        </Box>
      </Box>
      <Box height={1} overflow="hidden">
        {lead(false)}
        <Text color={t.textDim}>{`${LEDGER_INDENT}files ${SOFT_SEP}`}</Text>
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
  initialKind?: CustomCommandContract | undefined;
  configuredKind?: CustomCommandContract | undefined;
  onChoose: (kind: CustomCommandContract) => void;
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
    <SubPanel
      title="Custom command"
      role={role}
      stepIndicator={<StepIndicator active="contract" />}
      hint={`↑↓ select${SOFT_SEP}⏎ continue${SOFT_SEP}esc back`}
    >
      {CONTRACT_CARDS.map((card, cardIndex) => (
        <Box key={card.kind} flexDirection="column">
          <ContractCardView
            card={card}
            focused={cardIndex === index}
            configured={card.kind === configuredKind}
          />
          <Box height={1} />
        </Box>
      ))}
    </SubPanel>
  );
}
