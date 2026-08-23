import { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { SOFT_SEP } from '../../components/separators.js';
import { useTheme } from '../../components/theme.js';

import type { CliProviderAuthFact } from '../../core/discovery/detection.js';
import { formatModelName } from '../../core/model-display.js';
import {
  CLI_TOOL_CATALOG,
  CLI_TOOL_IDS,
  type ActiveRunnerRole,
} from '../../core/runners/cli-tool-catalog.js';
import { providerOracleCommand } from '../../engine/runners/cli-tools/provider-oracle.js';
import { glyph } from '../../lib/glyphs.js';
import { detectionStore } from '../../stores/project/detection.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { includes } from '../../utils/type-guards.js';
import {
  findProviderCredentialFacts,
  modelProviderAuthKey,
  type RunnerPickerOption,
} from './model-catalog/options.js';
import type { ModelOption, ModelVariant } from './model-catalog/recency.js';
import {
  formatAuthFactsUnavailableNotice,
  formatProviderConfiguredClause,
  formatProviderSignInClause,
  gatewayAccountName,
} from './picker-format.js';
import { SubPanel } from './sub-panel.js';
import { overlayAllowsPickerKeys } from '../../core/navigation/types.js';

interface LoginContext {
  loginCommand: string;
  gatewayKey: string;
  gatewayAccount: string | undefined;
}

type VariantAuthTruth =
  | { kind: 'configured'; clause: string }
  | { kind: 'needs-signin'; clause: string }
  | { kind: 'unknown' };

/**
 * Per-provider auth truth for one variant row. An unreadable oracle yields no
 * claim at all — never a false "needs sign-in".
 */
function variantAuthTruth(
  variant: ModelVariant,
  facts: readonly CliProviderAuthFact[] | undefined,
  login: LoginContext | undefined,
): VariantAuthTruth {
  if (facts === undefined || login === undefined) return { kind: 'unknown' };
  const authKey = modelProviderAuthKey(variant.fullId);
  if (authKey === undefined) return { kind: 'unknown' };
  const matched = findProviderCredentialFacts(authKey, facts);
  if (matched.length > 0) {
    return { kind: 'configured', clause: formatProviderConfiguredClause(variant.tag, matched) };
  }
  return {
    kind: 'needs-signin',
    clause: formatProviderSignInClause({
      tag: variant.tag,
      authKey,
      loginCommand: login.loginCommand,
      ...(authKey === login.gatewayKey ? { gatewayAccount: login.gatewayAccount } : {}),
    }),
  };
}

function VariantRow({
  variant,
  truth,
  focused,
}: {
  variant: ModelVariant;
  truth: VariantAuthTruth;
  focused: boolean;
}) {
  const t = useTheme();
  const lead = (first: boolean) =>
    focused ? (
      <Text color={t.accent}>{`${glyph('liveBar')} `}</Text>
    ) : (
      <Text color={t.textDim}>{first ? '· ' : '  '}</Text>
    );
  return (
    <Box flexDirection="column">
      <Box height={1} overflow="hidden">
        {lead(true)}
        <Box flexGrow={1} minWidth={0} overflow="hidden">
          <Text color={t.text} bold={focused} wrap="truncate-end">
            {variant.tag}
          </Text>
        </Box>
        {truth.kind !== 'unknown' ? (
          <Box flexShrink={0}>
            <Text color={truth.kind === 'configured' ? t.dimSuccess : t.warning}>
              {` ${glyph(truth.kind === 'configured' ? 'stageDone' : 'stagePending')}`}
            </Text>
          </Box>
        ) : null}
      </Box>
      {truth.kind !== 'unknown' ? (
        <Box height={1} overflow="hidden">
          {lead(false)}
          <Box flexGrow={1} minWidth={0} overflow="hidden">
            <Text color={t.textDim} wrap="truncate-end">
              {truth.clause}
            </Text>
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

interface ProviderChoiceOverlayProps {
  role: ActiveRunnerRole;
  item: RunnerPickerOption;
  model: ModelOption;
  onChoose: (fullId: string) => void;
}

export function ProviderChoiceOverlay({ role, item, model, onChoose }: ProviderChoiceOverlayProps) {
  const t = useTheme();
  const [index, setIndex] = useState(0);
  const variants = model.variants ?? [];
  const toolId = includes(CLI_TOOL_IDS, item.id) ? item.id : undefined;
  const facts = detectionStore.use((s) =>
    toolId === undefined
      ? undefined
      : s.cliTools.find((detection) => detection.tool === toolId)?.providerAuth,
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
      if (key.downArrow) setIndex((current) => Math.min(variants.length - 1, current + 1));
      if (key.return) {
        const variant = variants[index];
        if (variant) onChoose(variant.fullId);
      }
    },
    { isActive: focus },
  );

  const login: LoginContext | undefined =
    toolId === undefined
      ? undefined
      : {
          loginCommand: `${CLI_TOOL_CATALOG[toolId].command} auth login`,
          gatewayKey: CLI_TOOL_CATALOG[toolId].command,
          gatewayAccount: gatewayAccountName(toolId),
        };
  const oracleCommand = toolId === undefined ? undefined : providerOracleCommand(toolId)?.join(' ');

  return (
    <SubPanel
      title={formatModelName(model.id)}
      role={role}
      hint={`↑↓ select${SOFT_SEP}⏎ choose${SOFT_SEP}esc back`}
    >
      {variants.map((variant, variantIndex) => (
        <Box key={variant.fullId} flexDirection="column">
          <VariantRow
            variant={variant}
            truth={variantAuthTruth(variant, facts, login)}
            focused={variantIndex === index}
          />
          <Box height={1} />
        </Box>
      ))}
      {facts === undefined && oracleCommand !== undefined ? (
        <Box height={1} overflow="hidden">
          <Text color={t.textDim} wrap="truncate-end">
            {formatAuthFactsUnavailableNotice(oracleCommand)}
          </Text>
        </Box>
      ) : null}
    </SubPanel>
  );
}
