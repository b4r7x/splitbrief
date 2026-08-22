import { Box, Text } from 'ink';
import { SOFT_SEP } from '../../components/separators.js';
import { useTheme } from '../../components/theme.js';
import type { ActiveRunnerRole } from '../../core/runners/cli-tool-catalog.js';
import { CONFIG_FILE, SPLITBRIEF_DIR } from '../../core/paths.js';
import {
  getApiProviderDescriptor,
  type ApiProviderDescriptor,
} from '../../core/providers/api-provider-catalog.js';
import { glyph } from '../../lib/glyphs.js';
import { detectionStore } from '../../stores/project/detection.js';
import type { RunnerPickerOption } from './model-catalog/options.js';
import { formatBillingLabel, formatDataUseLabel } from './picker-format.js';
import { needsAuthAction } from './provider-auth.js';
import { TextInputOverlay } from './text-input-overlay.js';

function KeyRecap({ descriptor }: { descriptor: ApiProviderDescriptor }) {
  const t = useTheme();
  const digest = ` ${glyph('connectorHandoff')} ${formatBillingLabel(descriptor.billing)}${SOFT_SEP}${formatDataUseLabel(descriptor.dataUse)}`;
  return (
    <Box height={1} overflow="hidden">
      <Box flexShrink={0}>
        <Text color={t.warning}>{`${glyph('liveBar')} `}</Text>
        <Text color={t.warning} inverse>
          {' KEY '}
        </Text>
      </Box>
      <Box flexGrow={1} minWidth={0} overflow="hidden">
        <Text color={t.warning} wrap="truncate-end">
          {digest}
        </Text>
      </Box>
    </Box>
  );
}

interface ProviderAuthOverlayProps {
  role: ActiveRunnerRole;
  item: RunnerPickerOption;
  onSubmit: (value: string) => void;
}

export function ProviderAuthOverlay({ role, item, onSubmit }: ProviderAuthOverlayProps) {
  const detection = detectionStore.use((s) =>
    s.providers.find((provider) => provider.provider === item.id),
  );
  const descriptor = getApiProviderDescriptor(item.id);
  if (descriptor === undefined) return null;

  const action = needsAuthAction(item.status, detection, descriptor) ?? 'add-key';
  const env = descriptor.credentialEnv;
  return (
    <TextInputOverlay
      title={action === 'replace-key' ? 'Replace API key' : 'Add API key'}
      role={role}
      recap={<KeyRecap descriptor={descriptor} />}
      label={
        action === 'replace-key'
          ? `New ${descriptor.displayName} API key`
          : `${descriptor.displayName} API key`
      }
      placeholder={descriptor.credentialPrefix ? `${descriptor.credentialPrefix}…` : 'paste key'}
      mask={glyph('stageDone')}
      helper={env ? `preferred path: export ${env} in your shell` : undefined}
      examples={env ? [`export ${env}=…`] : undefined}
      hint={`⏎ validate & save to ${SPLITBRIEF_DIR}/${CONFIG_FILE} (0600)${SOFT_SEP}esc discard`}
      onSubmit={onSubmit}
    />
  );
}
