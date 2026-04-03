import { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { useAppContext } from "../app.js";
import { useTheme } from "../ui/theme.js";
import { useResponsiveLayout } from "../hooks/use-terminal-size.js";
import { useFilterableList } from "../hooks/use-filterable-list.js";
import { computeScrollOffset } from "../ui/picker-utils.js";
import { Spinner } from "../ui/spinner.js";
import {
  detectAvailablePlanners,
  detectAvailableImplementers,
} from "../engine/detection.js";
import { writeConfigSelection } from "../core/config.js";
import { FilterPanel, filterItem } from "./filter-panel.js";
import type { PickerItem } from "./filter-panel.js";
import type {
  PlannerDetection,
  ImplementerDetection,
} from "../engine/detection.js";
import type { PlannerTool } from "../types.js";

interface ConfigPickerProps {
  onClose: () => void;
  onSetExclusive: (v: boolean) => void;
}

function buildPlannerItems(planners: PlannerDetection[]): PickerItem[] {
  const items: PickerItem[] = [
    {
      id: "__custom__",
      label: "+ Custom shell command...",
      sublabel: "",
      isSentinel: true,
    },
  ];
  for (const p of planners) {
    if (!p.available) continue;
    items.push({
      id: p.tool,
      label: p.tool,
      sublabel: p.version ? `v${p.version}` : "",
    });
  }
  return items;
}

function buildModelItems(implementers: ImplementerDetection[]): PickerItem[] {
  const items: PickerItem[] = [
    {
      id: "__custom__",
      label: "+ Custom endpoint...",
      sublabel: "",
      isSentinel: true,
    },
  ];
  for (const imp of implementers) {
    if (!imp.available || !imp.models) continue;
    for (const model of imp.models) {
      items.push({
        id: `${imp.provider}/${model}`,
        label: model,
        sublabel: imp.provider,
      });
    }
  }
  return items;
}

type CustomStep = null | "planner-command" | "impl-provider" | "impl-model";
type CustomField = "provider" | "model";

export function ConfigPicker({ onClose, onSetExclusive }: ConfigPickerProps) {
  const t = useTheme();
  const { config, projectDir, reloadConfig } = useAppContext();
  const { cols, rows, isSmall } = useResponsiveLayout();

  const [phase, setPhase] = useState<"loading" | "ready">("loading");
  const [plannerItems, setPlannerItems] = useState<PickerItem[]>([]);
  const [modelItems, setModelItems] = useState<PickerItem[]>([]);
  const [activeSection, setActiveSection] = useState<"planner" | "model">(
    "planner",
  );

  const [selectedPlannerId, setSelectedPlannerId] = useState<string | null>(null);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [navigating, setNavigating] = useState(false);

  const [customStep, setCustomStep] = useState<CustomStep>(null);
  const [customInput, setCustomInput] = useState("");
  const [customProvider, setCustomProvider] = useState("");
  const [customField, setCustomField] = useState<CustomField>("provider");

  const [customPlannerData, setCustomPlannerData] = useState<{ command: string } | null>(null);
  const [customImplData, setCustomImplData] = useState<{ provider: string; model: string; apiBase?: string } | null>(null);

  useEffect(() => {
    onSetExclusive(!!customStep);
    return () => onSetExclusive(false);
  }, [customStep, onSetExclusive]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      detectAvailablePlanners(),
      detectAvailableImplementers(),
    ]).then(([planners, implementers]) => {
      if (cancelled) return;
      const pItems = buildPlannerItems(planners);
      const mItems = buildModelItems(implementers);
      setPlannerItems(pItems);
      setModelItems(mItems);

      const plannerMatch = pItems.findIndex((item) => item.id === config.planner.tool);
      if (plannerMatch >= 0) {
        setSelectedPlannerId(pItems[plannerMatch].id);
      }

      const implId = `${config.implementer.provider}/${config.implementer.model}`;
      const modelMatch = mItems.findIndex((item) => item.id === implId);
      if (modelMatch >= 0) {
        setSelectedModelId(mItems[modelMatch].id);
      }

      setPhase("ready");
    });
    return () => {
      cancelled = true;
    };
  }, [config.planner.tool, config.implementer.provider, config.implementer.model]);

  const totalWidth = Math.min(cols - 2, isSmall ? 76 : 120);
  const panelWidth = Math.floor((totalWidth - 2) / 2);
  const panelMaxVisible = Math.max(rows - 10, 4);
  const nameWidth = Math.min(Math.max(10, Math.floor(panelWidth * 0.55)), 30);
  const sublabelWidth = Math.max(8, panelWidth - nameWidth - 12);
  const modalWidth = Math.min(totalWidth, 60);

  const enterCustomForActive = () => {
    if (activeSection === "planner") {
      setCustomStep("planner-command");
      setCustomInput("");
    } else {
      setCustomStep("impl-provider");
      setCustomInput("");
      setCustomProvider("");
      setCustomField("provider");
    }
  };

  const tryConfirm = (plannerId: string | null, modelId: string | null, cpd: typeof customPlannerData, cid: typeof customImplData) => {
    if (!plannerId && !cpd) return;
    if (!modelId && !cid) return;
    const plannerConfig = cpd
      ? { tool: "shell" as PlannerTool, command: cpd.command }
      : { tool: plannerId as PlannerTool };
    const implConfig = cid
      ? { provider: cid.provider, model: cid.model, apiBase: cid.apiBase }
      : (() => {
          const [provider, ...rest] = modelId!.split("/");
          return { provider, model: rest.join("/") };
        })();
    writeConfigSelection(projectDir, plannerConfig, implConfig);
    reloadConfig();
    onClose();
  };

  const plannerList = useFilterableList({
    items: plannerItems,
    filterFn: filterItem,
    onSelect: (item) => {
      if (item.isSentinel) {
        enterCustomForActive();
        return;
      }
      setSelectedPlannerId(item.id);
      setCustomPlannerData(null);
      tryConfirm(item.id, selectedModelId, null, customImplData);
    },
    onClose,
    isActive: phase === "ready" && activeSection === "planner" && !customStep,
    shouldAppendChar: (ch) => !(ch === " " && navigating),
  });

  const modelList = useFilterableList({
    items: modelItems,
    filterFn: filterItem,
    onSelect: (item) => {
      if (item.isSentinel) {
        enterCustomForActive();
        return;
      }
      setSelectedModelId(item.id);
      setCustomImplData(null);
      tryConfirm(selectedPlannerId, item.id, customPlannerData, null);
    },
    onClose,
    isActive: phase === "ready" && activeSection === "model" && !customStep,
    shouldAppendChar: (ch) => !(ch === " " && navigating),
  });

  // Pre-set cursor to the matching config item after detection
  const [cursorInitialized, setCursorInitialized] = useState(false);
  useEffect(() => {
    if (phase !== "ready" || cursorInitialized) return;
    const plannerMatch = plannerList.filtered.findIndex((item) => item.id === config.planner.tool);
    if (plannerMatch >= 0) plannerList.setSelectedIndex(plannerMatch);

    const implId = `${config.implementer.provider}/${config.implementer.model}`;
    const modelMatch = modelList.filtered.findIndex((item) => item.id === implId);
    if (modelMatch >= 0) modelList.setSelectedIndex(modelMatch);

    setCursorInitialized(true);
  }, [phase, cursorInitialized, plannerList.filtered, modelList.filtered, config.planner.tool, config.implementer.provider, config.implementer.model]);

  // Layered input for navigation, space selection, panel switching
  useInput(
    (input, key) => {
      if (phase !== "ready" || customStep) return;

      if (key.upArrow || key.downArrow) {
        setNavigating(true);
        return;
      }
      if (key.backspace || key.delete) {
        setNavigating(false);
        return;
      }

      if (key.leftArrow || key.rightArrow) {
        setNavigating(true);
        setActiveSection((prev) =>
          prev === "planner" ? "model" : "planner",
        );
        return;
      }
      if (key.tab) {
        setActiveSection((prev) =>
          prev === "planner" ? "model" : "planner",
        );
        return;
      }

      if (input === " " && navigating) {
        const list = activeSection === "planner" ? plannerList : modelList;
        const item = list.filtered[list.selectedIndex];
        if (!item) return;
        if (item.isSentinel) {
          enterCustomForActive();
          return;
        }
        if (activeSection === "planner") {
          setSelectedPlannerId(item.id);
          setCustomPlannerData(null);
        } else {
          setSelectedModelId(item.id);
          setCustomImplData(null);
        }
        return;
      }

      if (input === "n" && key.ctrl) {
        enterCustomForActive();
        return;
      }

      if (input && !key.ctrl && !key.meta && input !== " ") {
        setNavigating(false);
      }
    },
    { isActive: phase === "ready" && !customStep },
  );

  // Custom modal input handling
  useInput(
    (input, key) => {
      if (key.escape) {
        setCustomStep(null);
        setCustomInput("");
        setCustomProvider("");
        return;
      }

      if (customStep === "planner-command") {
        if (key.return && customInput.trim()) {
          setCustomPlannerData({ command: customInput.trim() });
          setSelectedPlannerId(null);
          setCustomStep(null);
          setCustomInput("");
          return;
        }
        if (key.backspace || key.delete) {
          setCustomInput((prev) => prev.slice(0, -1));
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          setCustomInput((prev) => prev + input);
        }
        return;
      }

      if (customStep === "impl-provider" || customStep === "impl-model") {
        if (key.tab) {
          setCustomField((prev) =>
            prev === "provider" ? "model" : "provider",
          );
          return;
        }
        if (key.return) {
          if (customField === "provider" && customProvider.trim()) {
            setCustomInput("");
            setCustomField("model");
            setCustomStep("impl-model");
            return;
          }
          if (
            customField === "model" &&
            customInput.trim() &&
            customProvider.trim()
          ) {
            setCustomImplData({
              provider: customProvider.trim(),
              model: customInput.trim(),
              apiBase: customProvider.trim().startsWith("http")
                ? customProvider.trim()
                : undefined,
            });
            setSelectedModelId(null);
            setCustomStep(null);
            setCustomInput("");
            setCustomProvider("");
            return;
          }
        }
        if (key.backspace || key.delete) {
          if (customField === "provider") {
            setCustomProvider((prev) => prev.slice(0, -1));
          } else {
            setCustomInput((prev) => prev.slice(0, -1));
          }
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          if (customField === "provider") {
            setCustomProvider((prev) => prev + input);
          } else {
            setCustomInput((prev) => prev + input);
          }
        }
      }
    },
    { isActive: phase === "ready" && !!customStep },
  );

  if (phase === "loading") {
    return (
      <Box
        flexDirection="column"
        width={cols}
        height={rows}
        alignItems="center"
        justifyContent="center"
      >
        <Spinner label="Detecting planners and models..." color={t.accent} />
      </Box>
    );
  }

  const plannerScrollOffset = computeScrollOffset(
    plannerList.selectedIndex,
    panelMaxVisible,
    plannerList.filtered.length,
  );
  const modelScrollOffset = computeScrollOffset(
    modelList.selectedIndex,
    panelMaxVisible,
    modelList.filtered.length,
  );

  const plannerActive = activeSection === "planner" && !customStep;
  const modelActive = activeSection === "model" && !customStep;

  const hasBothSelections =
    (selectedPlannerId || customPlannerData) &&
    (selectedModelId || customImplData);

  const plannerDisplay = customPlannerData
    ? `__shell__:${customPlannerData.command}`
    : selectedPlannerId;
  const modelDisplay = customImplData
    ? `__custom__:${customImplData.provider}/${customImplData.model}`
    : selectedModelId;

  let footerHint: string;
  if (customStep === "planner-command") {
    footerHint = "Enter confirm  Esc cancel";
  } else if (customStep === "impl-provider" || customStep === "impl-model") {
    footerHint = "Tab switch field  Enter confirm  Esc cancel";
  } else if (navigating) {
    footerHint = `Space select  Tab/\u2190\u2192 switch  ${hasBothSelections ? "Enter save  " : ""}Ctrl+N custom  Esc cancel`;
  } else {
    footerHint = `\u2191\u2193 navigate  Tab/\u2190\u2192 switch  ${hasBothSelections ? "Enter save  " : ""}Ctrl+N custom  Esc cancel`;
  }

  return (
    <Box
      flexDirection="column"
      width={cols}
      height={rows}
      alignItems="center"
      paddingTop={1}
    >
      <Box justifyContent="center" marginBottom={1}>
        <Text bold color={t.accent}>
          Config
        </Text>
        {hasBothSelections && (
          <Text color={t.success}>{" \u2714 ready"}</Text>
        )}
      </Box>

      <Box
        display={customStep ? "none" : "flex"}
        flexDirection="row"
        gap={2}
        flexGrow={1}
      >
        <FilterPanel
          title="Planner"
          items={plannerList.filtered}
          filter={plannerList.filter}
          selectedIndex={plannerList.selectedIndex}
          scrollOffset={plannerScrollOffset}
          maxVisible={panelMaxVisible}
          isActive={plannerActive}
          width={panelWidth}
          nameWidth={nameWidth}
          sublabelWidth={sublabelWidth}
          emptyText="No planners detected"
          selectedId={plannerDisplay}
        />
        <FilterPanel
          title="Model"
          items={modelList.filtered}
          filter={modelList.filter}
          selectedIndex={modelList.selectedIndex}
          scrollOffset={modelScrollOffset}
          maxVisible={panelMaxVisible}
          isActive={modelActive}
          width={panelWidth}
          nameWidth={nameWidth}
          sublabelWidth={sublabelWidth}
          emptyText="No models detected"
          selectedId={modelDisplay}
        />
      </Box>

      {customStep && (
        <Box
          flexDirection="column"
          flexGrow={1}
          alignItems="center"
          justifyContent="center"
        >
          <Box
            flexDirection="column"
            width={modalWidth}
            borderStyle="round"
            borderColor={t.accent}
            paddingX={2}
            paddingY={1}
          >
            {customStep === "planner-command" && (
              <>
                <Box marginBottom={1}>
                  <Text bold color={t.accent}>
                    Custom Planner
                  </Text>
                </Box>
                <Text color={t.textDim}>Shell command:</Text>
                <Box borderStyle="round" borderColor={t.accent} paddingX={1}>
                  <Text color={t.accent}>{"> "}</Text>
                  <Text>
                    {customInput || (
                      <Text color={t.textDim}>
                        claude-zai -p --output-format stream-json
                      </Text>
                    )}
                  </Text>
                </Box>
              </>
            )}

            {(customStep === "impl-provider" ||
              customStep === "impl-model") && (
              <>
                <Box marginBottom={1}>
                  <Text bold color={t.accent}>
                    Custom Endpoint
                  </Text>
                </Box>
                <Text color={t.textDim}>Provider / API base URL:</Text>
                <Box
                  borderStyle="round"
                  borderColor={customField === "provider" ? t.accent : t.border}
                  paddingX={1}
                  marginBottom={1}
                >
                  <Text
                    color={customField === "provider" ? t.accent : t.textDim}
                  >
                    {"> "}
                  </Text>
                  <Text>
                    {customProvider || (
                      <Text color={t.textDim}>
                        ollama, lm-studio, or http://...
                      </Text>
                    )}
                  </Text>
                </Box>
                <Text color={t.textDim}>Model name:</Text>
                <Box
                  borderStyle="round"
                  borderColor={customField === "model" ? t.accent : t.border}
                  paddingX={1}
                >
                  <Text color={customField === "model" ? t.accent : t.textDim}>
                    {"> "}
                  </Text>
                  <Text>
                    {customInput || (
                      <Text color={t.textDim}>qwen2.5-coder:7b</Text>
                    )}
                  </Text>
                </Box>
              </>
            )}
          </Box>
        </Box>
      )}

      <Box justifyContent="center" paddingBottom={1}>
        <Text color={t.textDim}>{footerHint}</Text>
      </Box>
    </Box>
  );
}
