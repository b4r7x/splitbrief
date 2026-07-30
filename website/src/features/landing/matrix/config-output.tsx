import { useHydrated } from '@tanstack/react-router';
import { BorderedFrame } from '../../../components/bordered-frame.js';
import { type CopyFeedbackState, useCopyFeedback } from '../../../hooks/use-copy-feedback.js';

export interface ConfigOutputProps {
  readonly yaml: string;
}

const COPY_LABELS = {
  idle: 'Copy generated configuration',
  copied: 'Configuration copied',
  failed: 'Copy failed; retry',
} as const satisfies Record<CopyFeedbackState, string>;

const COPY_TEXT = {
  idle: '[ copy ]',
  copied: '[ copied ]',
  failed: '[ retry ]',
} as const satisfies Record<CopyFeedbackState, string>;

export function ConfigOutput({ yaml }: ConfigOutputProps) {
  const hydrated = useHydrated();
  const { copyState, copyText } = useCopyFeedback();

  return (
    <BorderedFrame
      actions={
        <button
          aria-label={COPY_LABELS[copyState]}
          className="config-output__copy"
          data-copy-state={copyState}
          disabled={!hydrated}
          onClick={() => void copyText(yaml)}
          type="button"
        >
          {COPY_TEXT[copyState]}
        </button>
      }
      className="config-output"
      label="Generated config"
    >
      <pre className="config-output__code">
        <code>{yaml}</code>
      </pre>
    </BorderedFrame>
  );
}
