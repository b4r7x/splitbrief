import type { RefObject } from 'react';
import { formatAttachmentFailure } from '../../core/attachments/failure.js';
import { attachmentShortName, resolveAttachment } from '../../core/attachments/resolve.js';
import { formatSeatIdentity } from '../../core/crew/identity.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import type { Config } from '../../core/schemas/config.js';
import { plannerSupportsImages } from '../../engine/providers/capabilities.js';
import { resolveSeatDisplayName } from '../../engine/providers/model/display-names.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { noVisionFeedbackMessage } from './home-hint.js';

interface UseAttachImageParams {
  config: Config | null;
  projectDir: string;
  caretRef: RefObject<number>;
  onReviewInteraction: (() => void) | undefined;
  noteEdit: () => void;
  /** Puts the image in the draft at a view offset; the length it took in the view. */
  insertImage: (attachment: Attachment, at: number) => number;
  bumpEpoch: () => void;
}

/** Whether the plan seat sees images, and the attach of an image file the operator dropped. */
export function useAttachImage({
  config,
  projectDir,
  caretRef,
  onReviewInteraction,
  noteEdit,
  insertImage,
  bumpEpoch,
}: UseAttachImageParams): {
  supportsImages: boolean;
  canAttachImage: () => boolean;
  handleFileDrop: (path: string, at?: number) => number | null;
} {
  modelCacheStore.use((cache) => cache.refresh.generation);
  const supportsImages = plannerSupportsImages(config, modelCacheStore);

  const canAttachImage = (): boolean => {
    if (!supportsImages) {
      if (config === null) {
        feedbackStore.setMessage(
          'Cannot attach image: the planner cannot see images. Choose a vision model with /crew plan.',
        );
        return false;
      }
      const displayName = resolveSeatDisplayName(config.planner, 'planner', modelCacheStore);
      feedbackStore.setMessage(
        noVisionFeedbackMessage(formatSeatIdentity({ seat: config.planner, displayName })),
      );
      return false;
    }
    return true;
  };

  const handleFileDrop = (path: string, at = caretRef.current) => {
    if (!canAttachImage()) return null;
    const result = resolveAttachment({ path, projectDir });
    if (!result.ok) {
      feedbackStore.setError(
        formatAttachmentFailure({ action: 'attach-image', reason: result.reason }),
      );
      return null;
    }
    onReviewInteraction?.();
    // The image is a part of the draft at the caret, so the caret has to land after it when the
    // input starts again. The seed is spent by the epoch it was made for; a later new start puts
    // the caret at the end as usual.
    noteEdit();
    const inserted = insertImage(result.attachment, at);
    bumpEpoch();
    // The box already says where the image went; this row says which file it was, in a name that
    // survives the narrow widths an absolute path is truncated to nothing at.
    feedbackStore.setMessage(`Attached: ${attachmentShortName(result.attachment.path)}`);
    return inserted;
  };

  return { supportsImages, canAttachImage, handleFileDrop };
}
