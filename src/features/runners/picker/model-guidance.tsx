import { Box } from 'ink';
import { useTheme, ThemeText as Text } from '../../../components/theme.js';
import type { PickerModelCounts } from '../model-catalog/catalog.js';
import type { PickerOption } from '../model-catalog/options.js';
import { type ModelCatalogDiagnostic, formatModelCatalogGuidance } from './catalog-guidance.js';

export function ModelGuidance({
  currentItem,
  counts,
  diagnostic,
  refreshing,
}: {
  currentItem: PickerOption;
  counts: PickerModelCounts;
  diagnostic: ModelCatalogDiagnostic | undefined;
  refreshing: boolean;
}) {
  const t = useTheme();
  const guidance = formatModelCatalogGuidance(currentItem, counts, diagnostic, refreshing);

  return (
    <Box flexDirection="column">
      <Text color={t.textDim} wrap="truncate-end">
        {guidance.headline}
      </Text>
      {guidance.detail ? (
        <Text color={t.textDim} wrap="truncate-end">
          {guidance.detail}
        </Text>
      ) : null}
    </Box>
  );
}
