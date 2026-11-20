import { useTheme } from '../../../components/theme.js';
import { useEffect } from 'react';
import { Box } from 'ink';
import { SOFT_SEP } from '../../../core/separators.js';
import { BACK_HINT, formatKeyHints, SELECT_HINT } from '../../../components/key-legend.js';
import { ListRow } from '../../../components/list-row/row.js';
import { planListRows } from '../../../components/list-row/plan.js';
import { overlayRect } from '../../../core/navigation/overlay-rect.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { useStaticSelector } from '../../../hooks/use-static-selector.js';
import { CREW_SEAT_LABELS } from '../../../core/crew/identity.js';
import { PICKER_ROLE_SEAT_IDS, type ActiveRunnerRole } from '../../../core/runners/seat-roles.js';
import { glyph } from '../../../lib/glyphs.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { PanelRow } from '../../../components/overlays/row.js';
import { OverlayPanel } from '../../../components/overlays/panel.js';
import { StepIndicator, tierColor } from './chip.js';
import {
  contractForRunnerKind,
  type CustomCommandRunnerKind,
} from '../../../core/config/custom-commands/tuple.js';
import { overlayAllowsPickerKeys } from '../../../core/navigation/types.js';

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
  width,
}: {
  card: ContractCard;
  focused: boolean;
  configured: boolean;
  width: number;
}) {
  const t = useTheme();
  const tier = contractForRunnerKind(card.kind);
  const color = tierColor(t, tier);
  const badge = tier === 'output' ? ' OUTPUT ' : ' DIRECT ';
  const check = configured ? ' ' + glyph('check') : '';
  const rows = [
    {
      name: badge + ' ' + card.title,
      nameParts: [
        { text: badge, color },
        { text: ' ' + card.title, color: focused ? t.accent : t.text },
      ],
      trailing: card.kind + check,
      trailingParts: [
        { text: card.kind, color: t.textDim },
        { text: check, color: t.success },
      ],
    },
    ...[
      ['result', card.resultClause, t.textDim],
      ['files ', card.filesClause, color],
    ].map(([field, value, hue]) => {
      const label = LEDGER_INDENT + field + SOFT_SEP;
      return {
        name: label + value,
        nameParts: [
          { text: label, color: t.textDim },
          { text: value ?? '', color: hue },
        ],
      };
    }),
  ];
  return (
    <PanelRow active={focused} flexDirection="column">
      {planListRows(rows, { width }).map((line) => (
        <ListRow key={line.row} line={line} selected={focused && line.row === 0} width={width} />
      ))}
    </PanelRow>
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
  const size = terminalSizeStore.use((state) => state);
  const { innerWidth } = overlayRect({ ...size, density: 'roomy' });
  const focus = overlayStore.use((s) => overlayAllowsPickerKeys(s.active));

  useEffect(() => {
    overlayStore.setExclusive(true);
    return () => {
      overlayStore.setExclusive(false);
    };
  }, []);

  const { selectedIndex: index } = useStaticSelector({
    items: CONTRACT_CARDS,
    initialIndex: Math.max(
      0,
      CONTRACT_CARDS.findIndex((card) => card.kind === initialKind),
    ),
    isActive: focus,
    onSelect: (card) => onChoose(card.kind),
  });

  return (
    <OverlayPanel
      density="roomy"
      title={`Custom command${SOFT_SEP}${CREW_SEAT_LABELS[PICKER_ROLE_SEAT_IDS[role]]}`}
      hint={formatKeyHints([SELECT_HINT, { key: '⏎', verb: 'continue' }, BACK_HINT])}
    >
      <Box marginBottom={1}>
        <StepIndicator active="contract" />
      </Box>
      {CONTRACT_CARDS.map((card, cardIndex) => (
        <Box key={card.kind} flexDirection="column" marginTop={cardIndex === 0 ? 0 : 1}>
          <ContractCardView
            width={innerWidth}
            card={card}
            focused={cardIndex === index}
            configured={card.kind === configuredKind}
          />
        </Box>
      ))}
    </OverlayPanel>
  );
}
