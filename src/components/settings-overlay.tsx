import { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "../ui/theme.js";
import { configStore } from "../stores/config.js";
import { overlayStore } from "../stores/overlay.js";
import { useResponsiveLayout } from "../hooks/use-terminal-size.js";
import { computeScrollOffset } from "../ui/picker-utils.js";
import { writeConfig } from "../core/config.js";
import type { Config } from "../types.js";

type SettingKind = "boolean" | "number" | "string" | "enum";

interface SettingDef {
  id: string;
  label: string;
  section: string;
  description: string;
  kind: SettingKind;
  options?: string[];
  min?: number;
  max?: number;
}

const SETTINGS_DEFS: SettingDef[] = [
  {
    id: "validation.typecheck",
    label: "typecheck",
    section: "Validation",
    description: "Run tsc type checking",
    kind: "boolean",
  },
  {
    id: "validation.lint",
    label: "lint",
    section: "Validation",
    description: "Run linter",
    kind: "boolean",
  },
  {
    id: "validation.test",
    label: "test",
    section: "Validation",
    description: "Run test suite",
    kind: "boolean",
  },
  {
    id: "validation.testCommand",
    label: "testCommand",
    section: "Validation",
    description: "Test runner command",
    kind: "string",
  },
  {
    id: "workflow.autoApproveSpec",
    label: "autoApproveSpec",
    section: "Workflow",
    description: "Skip spec review",
    kind: "boolean",
  },
  {
    id: "workflow.autoApprovePlan",
    label: "autoApprovePlan",
    section: "Workflow",
    description: "Skip plan review",
    kind: "boolean",
  },
  {
    id: "workflow.maxRetries",
    label: "maxRetries",
    section: "Workflow",
    description: "Max retry attempts per task",
    kind: "number",
    min: 0,
    max: 10,
  },
  {
    id: "workflow.commitPerTask",
    label: "commitPerTask",
    section: "Workflow",
    description: "Git commit after each task",
    kind: "boolean",
  },
  {
    id: "theme",
    label: "theme",
    section: "Appearance",
    description: "Color palette mode",
    kind: "enum",
    options: ["terminal", "mono"],
  },
  {
    id: "shikiTheme",
    label: "shikiTheme",
    section: "Appearance",
    description: "Syntax highlighting theme",
    kind: "string",
  },
  {
    id: "implementer.temperature",
    label: "temperature",
    section: "Implementer",
    description: "0=precise  0.3=balanced  1+=creative",
    kind: "number",
    min: 0,
    max: 2,
  },
  {
    id: "implementer.contextLength",
    label: "contextLength",
    section: "Implementer",
    description: "Token context window",
    kind: "number",
    min: 1024,
    max: 131072,
  },
  {
    id: "implementer.timeout",
    label: "timeout",
    section: "Implementer",
    description: "Request timeout (ms)",
    kind: "number",
    min: 0,
    max: 600000,
  },
  {
    id: "sessions.scope",
    label: "scope",
    section: "Sessions",
    description: "Session storage scope",
    kind: "enum",
    options: ["project", "global"],
  },
];

export { SETTINGS_DEFS };
export type { SettingDef, SettingKind };

export function getConfigValue(config: Config, dotPath: string): unknown {
  const parts = dotPath.split(".");
  let current: unknown = config;
  for (const part of parts) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object"
    )
      return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function applyEdits(
  config: Config,
  edits: Record<string, unknown>,
): Config {
  const clone: Record<string, unknown> = JSON.parse(JSON.stringify(config));
  for (const [dotPath, value] of Object.entries(edits)) {
    const parts = dotPath.split(".");
    let current = clone;
    for (let i = 0; i < parts.length - 1; i++) {
      if (
        current[parts[i]] === undefined ||
        current[parts[i]] === null ||
        typeof current[parts[i]] !== "object"
      ) {
        current[parts[i]] = {};
      }
      current = current[parts[i]] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]] = value;
  }
  return clone as unknown as Config;
}

function matchesFilter(def: SettingDef, query: string): boolean {
  const q = query.toLowerCase();
  return (
    def.label.toLowerCase().includes(q) ||
    def.description.toLowerCase().includes(q) ||
    def.section.toLowerCase().includes(q)
  );
}

function validateNumber(value: string, def: SettingDef): number | null {
  const num = Number(value);
  if (isNaN(num)) return null;
  if (def.min !== undefined && num < def.min) return null;
  if (def.max !== undefined && num > def.max) return null;
  if (def.id === "workflow.maxRetries" && !Number.isInteger(num)) return null;
  if (def.id === "implementer.contextLength" && !Number.isInteger(num))
    return null;
  if (def.id === "implementer.timeout" && !Number.isInteger(num)) return null;
  return num;
}

function displayValue(def: SettingDef, value: unknown): string {
  if (def.kind === "boolean") return value ? "[\u2713]" : "[\u2717]";
  if (value !== undefined && value !== null) return `[${String(value)}]`;
  return "[\u2014]";
}

export function SettingsOverlay() {
  const t = useTheme();
  const config = configStore.use(s => s.config);
  const projectDir = configStore.use(s => s.projectDir);
  const reloadConfig = configStore.reload;
  const onClose = overlayStore.close;
  const onSetExclusive = overlayStore.setExclusive;
  const { cols, rows } = useResponsiveLayout();

  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBuffer, setEditBuffer] = useState("");
  const [filter, setFilter] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const filtered = filter
    ? SETTINGS_DEFS.filter((def) => matchesFilter(def, filter))
    : SETTINGS_DEFS;

  const clampedIndex = Math.min(
    selectedIndex,
    Math.max(0, filtered.length - 1),
  );
  if (clampedIndex !== selectedIndex && filtered.length > 0) {
    setSelectedIndex(clampedIndex);
  }

  useEffect(() => {
    onSetExclusive(!!editingId);
  }, [editingId, onSetExclusive]);

  const getValue = (def: SettingDef): unknown =>
    config && edits[def.id] !== undefined
      ? edits[def.id]
      : config ? getConfigValue(config, def.id) : undefined;

  const saveAndClose = () => {
    if (config && Object.keys(edits).length > 0) {
      const updated = applyEdits(config, edits);
      writeConfig(projectDir, updated);
      reloadConfig();
    }
    onClose();
  };

  const startEditing = (def: SettingDef) => {
    const current = getValue(def);
    setEditingId(def.id);
    setEditBuffer(
      current !== undefined && current !== null ? String(current) : "",
    );
  };

  const confirmEdit = () => {
    if (!editingId) return;
    const def = SETTINGS_DEFS.find((d) => d.id === editingId);
    if (!def) return;

    if (def.kind === "number") {
      const num = validateNumber(editBuffer, def);
      if (num !== null) {
        setEdits((prev) => ({ ...prev, [def.id]: num }));
      }
    } else {
      const trimmed = editBuffer.trim();
      if (trimmed) {
        setEdits((prev) => ({ ...prev, [def.id]: trimmed }));
      }
    }
    setEditingId(null);
    setEditBuffer("");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditBuffer("");
  };

  useInput(
    (input, key) => {
      if (key.escape) {
        cancelEdit();
        return;
      }
      if (key.return) {
        confirmEdit();
        return;
      }
      if (key.backspace || key.delete) {
        setEditBuffer((prev) => prev.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta)
        setEditBuffer((prev) => prev + input);
    },
    { isActive: !!editingId },
  );

  useInput(
    (input, key) => {
      if (key.escape) {
        saveAndClose();
        return;
      }
      if (key.upArrow) {
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : filtered.length - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((prev) => (prev < filtered.length - 1 ? prev + 1 : 0));
        return;
      }
      if (input === " " && filtered.length > 0) {
        const def = filtered[selectedIndex];
        if (def.kind === "boolean") {
          const current = getValue(def);
          setEdits((prev) => ({ ...prev, [def.id]: !current }));
        } else if (def.kind === "enum" && def.options) {
          const current = String(getValue(def) ?? def.options[0]);
          const idx = def.options.indexOf(current);
          const next = def.options[(idx + 1) % def.options.length];
          setEdits((prev) => ({ ...prev, [def.id]: next }));
        }
        return;
      }
      if (key.return && filtered.length > 0) {
        const def = filtered[selectedIndex];
        if (def.kind === "string" || def.kind === "number") startEditing(def);
        return;
      }
      if (key.backspace || key.delete) {
        setFilter((prev) => prev.slice(0, -1));
        setSelectedIndex(0);
        return;
      }
      if (input && !key.ctrl && !key.meta && input !== " ") {
        setFilter((prev) => prev + input);
        setSelectedIndex(0);
      }
    },
    { isActive: !editingId },
  );

  if (!config) return null;

  const contentWidth = Math.min(cols - 4, 60);
  const maxVisible = rows - 10;
  const scrollOffset = computeScrollOffset(
    selectedIndex,
    maxVisible,
    filtered.length,
  );
  const visible = filtered.slice(scrollOffset, scrollOffset + maxVisible);

  let lastSection = "";
  const hasChanges = Object.keys(edits).length > 0;
  const selectedDef = filtered[selectedIndex];

  return (
    <Box width={cols} height={rows} alignItems="center" justifyContent="center">
      <Box
        flexDirection="column"
        width={contentWidth}
        borderStyle="round"
        borderColor={t.border}
        paddingX={2}
        paddingY={1}
      >
        <Box justifyContent="center" marginBottom={1}>
          <Text bold color={t.accent}>
            Settings
          </Text>
          {hasChanges && <Text color={t.warning}> (unsaved)</Text>}
        </Box>

        <Box marginBottom={1}>
          <Text color={t.textDim}>{`> ${filter || "type to filter..."}`}</Text>
        </Box>

        {scrollOffset > 0 && <Text color={t.textDim}>{"  \u2191 more"}</Text>}

        <Box flexDirection="column">
          {visible.map((def, i) => {
            const globalIndex = scrollOffset + i;
            const isSelected = globalIndex === selectedIndex;
            const isEditing = editingId === def.id;
            const value = getValue(def);
            const showSection = def.section !== lastSection;
            if (showSection) lastSection = def.section;

            return (
              <Box key={def.id} flexDirection="column">
                {showSection && (
                  <Box marginTop={i > 0 ? 1 : 0}>
                    <Text bold color={t.text}>
                      {def.section}
                    </Text>
                  </Box>
                )}
                <Box justifyContent="space-between">
                  <Text color={isSelected ? t.accent : t.textDim}>
                    {isSelected ? "\u25B8 " : "  "}
                    <Text color={isSelected ? t.text : t.textDim}>
                      {def.label}
                    </Text>
                  </Text>

                  {isEditing ? (
                    <Text color={t.accent}>[{editBuffer}|]</Text>
                  ) : (
                    <Text
                      color={
                        def.kind === "boolean"
                          ? value
                            ? t.success
                            : t.textDim
                          : t.textDim
                      }
                    >
                      {displayValue(def, value)}
                    </Text>
                  )}
                </Box>
              </Box>
            );
          })}
        </Box>

        {scrollOffset + maxVisible < filtered.length && (
          <Text color={t.textDim}>{"  \u2193 more"}</Text>
        )}

        {filtered.length === 0 && (
          <Box justifyContent="center" marginY={1}>
            <Text color={t.textDim}>No settings match filter</Text>
          </Box>
        )}

        <Box marginTop={1}>
          <Text color={t.textDim} dimColor>
            {selectedDef ? selectedDef.description : ""}
          </Text>
        </Box>

        <Box justifyContent="center">
          {editingId ? (
            <Text color={t.textDim}>Enter confirm Esc cancel</Text>
          ) : (
            <Text color={t.textDim}>
              {"\u2191\u2193 nav  Space toggle  Enter edit  Esc close"}
            </Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}
