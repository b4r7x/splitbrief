import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useTheme } from "../ui/theme.js";
import { configStore } from "../stores/config.js";
import { overlayStore } from "../stores/overlay.js";
import { useResponsiveLayout } from "../hooks/use-terminal-size.js";
import { computeScrollOffset } from "../ui/picker-utils.js";
import {
  SETTINGS_DEFS,
  getConfigValue,
  applyEdits,
  matchesFilter,
  validateNumber,
  displayValue,
  valueColor,
} from "./settings-defs.js";
import type { SettingDef } from "./settings-defs.js";

export function SettingsOverlay() {
  const t = useTheme();
  const config = configStore.use(s => s.config);
  const onClose = overlayStore.close;
  const focusSetting = overlayStore.use(s => s.focus);
  const { cols, rows } = useResponsiveLayout();

  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBuffer, setEditBuffer] = useState("");
  const [filter, setFilter] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(() => {
    if (!focusSetting) return 0;
    const idx = SETTINGS_DEFS.findIndex(d => d.id === focusSetting);
    return idx >= 0 ? idx : 0;
  });

  const filtered = filter
    ? SETTINGS_DEFS.filter((def) => matchesFilter(def, filter))
    : SETTINGS_DEFS;

  const effectiveIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1));

  const isDisabled = (def: SettingDef): boolean => !!(config && def.disabled?.(config));

  const getValue = (def: SettingDef): unknown => {
    if (def.id in edits) return edits[def.id];
    return config ? getConfigValue(config, def.id) : undefined;
  };

  const applyEdit = (dotPath: string, value: unknown) => {
    setEdits(prev => ({ ...prev, [dotPath]: value }));
  };

  const saveAndClose = () => {
    if (config && Object.keys(edits).length > 0) {
      configStore.save(applyEdits(config, edits));
    }
    onClose();
  };

  const openSubPicker = (def: SettingDef) => {
    if (def.id.startsWith('planner.')) overlayStore.open('planner-picker');
    else if (def.id.startsWith('implementer.')) overlayStore.open('implementer-picker');
  };

  const startEditing = (def: SettingDef) => {
    const current = getValue(def);
    setEditingId(def.id);
    setEditBuffer(current !== undefined && current !== null ? String(current) : "");
    overlayStore.setExclusive(true);
  };

  const confirmEdit = () => {
    if (!editingId || !config) return;
    const def = SETTINGS_DEFS.find((d) => d.id === editingId);
    if (!def) return;

    if (def.kind === "number") {
      const num = validateNumber(editBuffer, def);
      if (num !== null) applyEdit(def.id, num);
    } else {
      const trimmed = editBuffer.trim();
      if (trimmed) applyEdit(def.id, trimmed);
    }
    setEditingId(null);
    setEditBuffer("");
    overlayStore.setExclusive(false);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditBuffer("");
    overlayStore.setExclusive(false);
  };

  useInput(
    (input, key) => {
      if (key.escape) { cancelEdit(); return; }
      if (key.return) { confirmEdit(); return; }
      if (key.backspace || key.delete) { setEditBuffer((prev) => prev.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) setEditBuffer((prev) => prev + input);
    },
    { isActive: !!editingId },
  );

  useInput(
    (input, key) => {
      if (key.escape) { onClose(); return; }
      if (input === 's' && key.ctrl) { saveAndClose(); return; }
      if (key.upArrow) {
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : filtered.length - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((prev) => (prev < filtered.length - 1 ? prev + 1 : 0));
        return;
      }
      if (input === " " && filtered.length > 0) {
        const def = filtered[effectiveIndex];
        if (isDisabled(def)) return;
        if (def.kind === "boolean") {
          const current = getValue(def);
          applyEdit(def.id, !current);
        } else if (def.kind === "enum" && def.options) {
          const current = String(getValue(def) ?? def.options[0]);
          const idx = def.options.indexOf(current);
          const next = def.options[(idx + 1) % def.options.length];
          applyEdit(def.id, next);
        }
        return;
      }
      if (key.return && filtered.length > 0) {
        const def = filtered[effectiveIndex];
        if (isDisabled(def)) return;
        if (def.kind === "picker") { openSubPicker(def); return; }
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
  const scrollOffset = computeScrollOffset(effectiveIndex, maxVisible, filtered.length);
  const visible = filtered.slice(scrollOffset, scrollOffset + maxVisible);

  const sectionBreaks = new Set<number>();
  {
    let prev = "";
    for (let i = 0; i < visible.length; i++) {
      if (visible[i].section !== prev) {
        sectionBreaks.add(scrollOffset + i);
        prev = visible[i].section;
      }
    }
  }
  const selectedDef = filtered[effectiveIndex];

  return (
    <Box width={cols} height={rows} alignItems="center" justifyContent="center">
      <Box flexDirection="column" width={contentWidth} borderStyle="round" borderColor={t.border} paddingX={2} paddingY={1}>
        <Box justifyContent="center" marginBottom={1}>
          <Text bold color={t.accent}>Settings</Text>
        </Box>

        <Box marginBottom={1}>
          <Text color={t.textDim}>{`> ${filter || "type to filter..."}`}</Text>
        </Box>

        {scrollOffset > 0 && <Text color={t.textDim}>{"  \u2191 more"}</Text>}

        <Box flexDirection="column">
          {visible.map((def, i) => {
            const globalIndex = scrollOffset + i;
            const isSelected = globalIndex === effectiveIndex;
            const isEditing = editingId === def.id;
            const value = getValue(def);
            const disabled = isDisabled(def);
            const showSection = sectionBreaks.has(scrollOffset + i);

            return (
              <Box key={def.id} flexDirection="column">
                {showSection && (
                  <Box marginTop={i > 0 ? 1 : 0}>
                    <Text bold color={t.text}>{def.section}</Text>
                  </Box>
                )}
                <Box justifyContent="space-between">
                  <Text color={isSelected ? t.accent : t.textDim}>
                    {isSelected ? "\u25B8 " : "  "}
                    <Text color={disabled || !isSelected ? t.textDim : t.text}>
                      {def.label}
                    </Text>
                  </Text>

                  {isEditing ? (
                    <Text color={t.accent}>[{editBuffer}|]</Text>
                  ) : (
                    <Text color={valueColor(def, value, disabled, t)}>
                      {displayValue(def, value, disabled)}
                      {def.kind === "picker" && !disabled ? " \u2192" : ""}
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
              {"\u2191\u2193 nav  Space toggle  Enter edit  ^S save  Esc discard"}
            </Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}
