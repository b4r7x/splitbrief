import { useEffect, useRef } from 'react';
import { useInput, type Key } from 'ink';
import { stopStore, stoppedOrStopping } from '../stores/workflow/stop.js';
import { feedbackStore } from '../stores/ui/feedback.js';
import { overlayStore } from '../stores/ui/overlay.js';
import type { RouteData } from '../stores/navigation/router.js';
import { getActiveFilteredStdin } from '../lib/terminal/filtered-stdin/active.js';
import { activeApply } from '../engine/orchestrator/session-lifecycle/shutdown.js';
import type { CopyOutcome } from '../lib/clipboard/copy.js';
import { formatCopyResult } from '../core/runtime/commands/types.js';
import type { AppKeyDeps } from './keys.js';

interface UseCtrlCKeysOptions {
  route: RouteData;
  exit: () => void;
  deps: Pick<AppKeyDeps, 'requestQuit' | 'requestStopNow'>;
}

// A late read hands Ink every byte it collected as one input, so two Ctrl+C presses arrive as
// `\x03\x03` with no ctrl flag, and text typed around them shares the chunk (`fix\x03\x03`). Each
// `\x03` is still one press, and every other byte is other input, in the order it was typed.
function ctrlCKeys(input: string, key: Key): ('press' | 'other')[] {
  if (key.ctrl && input === 'c') return ['press'];
  return Array.from(input, (char) => (char === '\x03' ? 'press' : 'other'));
}

/**
 * Ctrl+C stops a live run and arms the quit hint; a second press quits. A selection copy clears the
 * hint and shows its receipt. Returns the exit that runs once.
 */
export function useCtrlCKeys({ route, exit, deps }: UseCtrlCKeysOptions): () => void {
  const quitUntil = useRef(0);
  const copyRevision = useRef(0);
  const quitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const exited = useRef(false);
  const exitOnce = () => {
    if (!exited.current) {
      exited.current = true;
      exit();
    }
  };
  const clearQuitHint = () => {
    copyRevision.current++;
    quitUntil.current = 0;
    clearTimeout(quitTimer.current);
    if (feedbackStore.get().message === 'Press ctrl+c again to quit')
      feedbackStore.setMessage(null);
  };
  const armQuit = () => {
    clearTimeout(quitTimer.current);
    quitUntil.current = Date.now() + 2000;
    feedbackStore.setMessage('Press ctrl+c again to quit');
    quitTimer.current = setTimeout(clearQuitHint, 2000);
  };

  const sessionProject = route.screen === 'workflow' ? route.run.ref.projectDir : null;
  const sessionId = route.screen === 'workflow' ? route.run.ref.sessionId : null;
  const localExecution =
    route.screen === 'workflow' && route.execution.kind === 'local'
      ? route.execution.prepared
      : null;
  useEffect(() => {
    clearQuitHint();
    return clearQuitHint;
  }, [route.screen, sessionProject, sessionId]);
  useEffect(() => {
    if (localExecution !== null) clearQuitHint();
  }, [localExecution]);
  useEffect(
    () =>
      stopStore.subscribe(() => {
        if (stopStore.get().intent === 'none') clearQuitHint();
      }),
    [],
  );

  useEffect(() => {
    const stdin = getActiveFilteredStdin()?.stdin;
    if (!stdin) return;
    const onCopyKey = (result: Promise<CopyOutcome | undefined>) => {
      clearQuitHint();
      const revision = copyRevision.current;
      const feedback = feedbackStore.get();
      void result.then((outcome) => {
        if (
          outcome === undefined ||
          copyRevision.current !== revision ||
          feedbackStore.get() !== feedback
        )
          return;
        if (outcome === 'unavailable') feedbackStore.setError(formatCopyResult(outcome));
        else feedbackStore.setMessage(formatCopyResult(outcome));
      });
    };
    stdin.on('selection-copy', onCopyKey);
    return () => {
      copyRevision.current++;
      stdin.off('selection-copy', onCopyKey);
    };
  }, []);

  useInput((input, key) => {
    copyRevision.current++;
    const keys = ctrlCKeys(input, key);
    if (!keys.includes('press')) {
      clearQuitHint();
      return;
    }
    if (getActiveFilteredStdin()?.isPasteActive()) return;
    for (const pressed of keys) {
      if (pressed === 'other') {
        clearQuitHint();
        continue;
      }
      const phase = stopStore.get().phase;
      const stopping =
        stoppedOrStopping() && phase !== 'parked' && phase !== 'ended' && phase !== 'failed';
      // An Apply cannot be cut: the first press queues the quit behind it, and the byline says so.
      if (quitUntil.current > Date.now() || stopping || activeApply() !== undefined) {
        clearQuitHint();
        deps.requestQuit(exitOnce);
        return;
      }
      armQuit();
      if (
        route.screen === 'workflow' &&
        route.execution.kind !== 'at-rest' &&
        !stoppedOrStopping()
      ) {
        if (overlayStore.get().active === 'stop-sheet') overlayStore.close();
        deps.requestStopNow();
      }
    }
  });

  return exitOnce;
}
