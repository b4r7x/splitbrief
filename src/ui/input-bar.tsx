import { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { MultilineInput } from "ink-multiline-input";
import { SlashSuggestions, filterCommands } from "./slash-suggestions.js";
import type { InputMode, Screen, SlashCommandDef } from "../types.js";
import type { Theme } from "../theme.js";

interface InputBarProps {
  onSubmit: (text: string) => void;
  onSlashCommand: (command: string) => void;
  commands: SlashCommandDef[];
  errorMessage?: string | null;
  onClearError?: () => void;
  mode: InputMode;
  hint: string;
  currentScreen: Screen;
  theme: Theme;
}

export function InputBar({
  onSubmit,
  onSlashCommand,
  commands,
  errorMessage,
  onClearError,
  mode,
  hint,
  currentScreen,
  theme,
}: InputBarProps) {
  const [value, setValue] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const slashMode = value.startsWith("/");
  const filtered = slashMode
    ? filterCommands(commands, value, currentScreen)
    : [];

  const showSuggestions = slashMode && filtered.length > 0;
  const clampedIndex =
    filtered.length > 0 ? Math.min(selectedIndex, filtered.length - 1) : 0;

  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue) {
    setPrevValue(value);
    setSelectedIndex(0);
  }

  useEffect(() => {
    if (!errorMessage || !onClearError) return;
    const timer = setTimeout(onClearError, 3000);
    return () => clearTimeout(timer);
  }, [errorMessage, onClearError]);

  const handleSubmit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    if (trimmed.startsWith("/")) {
      onSlashCommand(trimmed);
    } else {
      onSubmit(trimmed);
    }
    setValue("");
  };

  const executeSelected = () => {
    if (clampedIndex >= 0 && filtered[clampedIndex]) {
      onSlashCommand(filtered[clampedIndex].name);
      setValue("");
    }
  };

  useInput(
    (input, key) => {
      if (key.escape) {
        setValue("");
        return;
      }
      if (key.return) {
        executeSelected();
        return;
      }
      if (key.upArrow) {
        if (filtered.length === 0) return;
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : filtered.length - 1));
        return;
      }
      if (key.downArrow) {
        if (filtered.length === 0) return;
        setSelectedIndex((prev) => (prev < filtered.length - 1 ? prev + 1 : 0));
        return;
      }
      if (key.tab && filtered.length > 0) {
        if (filtered[clampedIndex]) setValue(filtered[clampedIndex].name);
        return;
      }
      if (key.backspace || key.delete) {
        setValue((prev) => prev.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setValue((prev) => prev + input);
      }
    },
    { isActive: showSuggestions },
  );

  return (
    <Box flexDirection="column" width="100%">
      {!showSuggestions && currentScreen === "home" && (
        <Box justifyContent="center">
          <Text color={theme.textDim}>/help /status /init Ctrl+K palette</Text>
        </Box>
      )}
      {showSuggestions && (
        <SlashSuggestions
          filtered={filtered}
          selectedIndex={clampedIndex}
          theme={theme}
        />
      )}
      <Box
        borderStyle="round"
        borderColor={theme.border}
        paddingX={1}
        width="100%"
      >
        <Text color={theme.accent}>&gt; </Text>
        {showSuggestions && (
          <Text>
            {value}
            <Text color={theme.textDim}>│</Text>
          </Text>
        )}
        <Box display={showSuggestions ? "none" : "flex"}>
          <MultilineInput
            value={value}
            onChange={setValue}
            onSubmit={handleSubmit}
            focus={!showSuggestions}
            placeholder={
              hint ||
              (mode === "review"
                ? "approve / edit / comment ... / quit"
                : mode === "question"
                  ? "type your answer..."
                  : "describe your feature...")
            }
            rows={1}
            maxRows={6}
            keyBindings={{
              submit: (key: { return: boolean }) => key.return,
              newline: (key: { return: boolean; shift: boolean }) =>
                key.return && key.shift,
            }}
          />
        </Box>
      </Box>
      {errorMessage && (
        <Box paddingX={2}>
          <Text color={theme.error}>{errorMessage}</Text>
        </Box>
      )}
    </Box>
  );
}
