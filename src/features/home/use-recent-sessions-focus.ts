import { useInput } from 'ink';

interface UseRecentSessionsFocusOptions {
  hasSessions: boolean;
  hasOverlay: boolean;
  focused: boolean;
  onEnter: () => void;
}

export function useRecentSessionsFocus({
  hasSessions,
  hasOverlay,
  focused,
  onEnter,
}: UseRecentSessionsFocusOptions): void {
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'r') onEnter();
    },
    { isActive: !hasOverlay && !focused && hasSessions },
  );
}
