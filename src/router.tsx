import React from "react";
import { HomeScreen } from "./screens/home.js";
import { WorkflowScreen } from "./screens/workflow.js";
import { SummaryScreen } from "./screens/summary.js";
import { HelpOverlay } from "./ui/help-overlay.js";
import { CommandPalette } from "./ui/command-palette.js";
import type {
  Screen,
  RouteData,
  Config,
  CommandPaletteItem,
  OverlayType,
} from "./types.js";
import type { Session } from "./types.js";
import type { getTheme } from "./theme.js";

interface RouterProps {
  screen: Screen;
  routeData: RouteData;
  overlayActive: OverlayType;
  onCloseOverlay: () => void;
  onOpenOverlay: (type: OverlayType) => void;
  config: Config;
  theme: ReturnType<typeof getTheme>;
  sessions: Session[];
  auto: boolean;
  projectDir: string;
  paletteItems: CommandPaletteItem[];
  errorMessage: string | null;
  onClearError: () => void;
  onSlashCommand: (raw: string, from: Screen) => void;
  navigate: (to: "home" | "workflow" | "summary", data?: any) => void;
  exit: () => void;
}

export function Router({
  screen,
  routeData,
  overlayActive,
  onCloseOverlay,
  onOpenOverlay,
  config,
  theme,
  sessions,
  auto,
  projectDir,
  paletteItems,
  errorMessage,
  onClearError,
  onSlashCommand,
  navigate,
}: RouterProps) {
  if (overlayActive === "help") {
    return <HelpOverlay onClose={onCloseOverlay} theme={theme} currentScreen={screen} />;
  }

  if (overlayActive === "command-palette") {
    return (
      <CommandPalette
        items={paletteItems}
        currentScreen={screen}
        onExecute={(item) => {
          onCloseOverlay();
          item.action();
        }}
        onClose={onCloseOverlay}
        theme={theme}
      />
    );
  }

  switch (screen) {
    case "home":
      return (
        <HomeScreen
          config={config}
          sessions={sessions}
          onStartWorkflow={(feat) => navigate("workflow", { feature: feat })}
          onSlashCommand={(raw) => onSlashCommand(raw, "home")}
          onOpenOverlay={onOpenOverlay}
          errorMessage={errorMessage}
          onClearError={onClearError}
          theme={theme}
        />
      );

    case "workflow":
      if (routeData.screen !== "workflow") return null;
      return (
        <WorkflowScreen
          feature={routeData.feature}
          config={config}
          theme={theme}
          auto={auto}
          projectDir={projectDir}
          resumeState={routeData.resumeState}
          onComplete={(summary) => navigate("summary", { summary })}
          onSlashCommand={(raw) => onSlashCommand(raw, "workflow")}
          onOpenOverlay={onOpenOverlay}
          errorMessage={errorMessage}
          onClearError={onClearError}
        />
      );

    case "summary":
      if (routeData.screen !== "summary") return null;
      return (
        <SummaryScreen
          summary={routeData.summary}
          theme={theme}
          onDone={() => navigate("home")}
          onSlashCommand={(raw) => onSlashCommand(raw, "summary")}
          errorMessage={errorMessage}
          onClearError={onClearError}
        />
      );
  }
}
