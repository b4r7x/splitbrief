import { detectionStore } from '../../stores/project/detection.js';
import { configStore } from '../../stores/project/config.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { getDefaultDetectionService } from '../../engine/detection/service.js';
import { refreshDetectionForCurrentConfig } from '../../engine/detection/store-publication.js';
import {
  formatDiscoveryRefreshFeedback,
  type DiscoveryRefreshSummary,
} from '../../core/runtime/commands/types.js';
import { toErrorMessage } from '../../utils/format-errors.js';

const defaultRefresh = (projectDir: string | undefined): Promise<DiscoveryRefreshSummary> =>
  refreshDetectionForCurrentConfig({
    service: getDefaultDetectionService(),
    publication: detectionStore,
    getCurrent: () => {
      const config = configStore.get().config;
      if (config === null || projectDir === undefined) return null;
      return { config, projectDir };
    },
  });

export async function refreshPickerDetection(
  projectDir: string,
  refresh: (projectDir: string | undefined) => Promise<DiscoveryRefreshSummary> = defaultRefresh,
): Promise<void> {
  feedbackStore.setMessage('Refreshing models…');
  try {
    const summary = await refresh(projectDir);
    const feedback = formatDiscoveryRefreshFeedback({ subject: 'Models', summary });
    if (feedback.isError) feedbackStore.setError(feedback.message);
    else feedbackStore.setMessage(feedback.message);
  } catch (err) {
    feedbackStore.setError(`Failed to refresh models: ${toErrorMessage(err)}`);
  }
}
