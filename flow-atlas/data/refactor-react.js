window.ATLAS_REFACTOR = window.ATLAS_REFACTOR || [];
window.ATLAS_REFACTOR.push({
  part: 'react',
  title: 'React / Ink: src/app, src/features, src/components, src/hooks',
  summary: `Warstwa React ma 282 pliki produkcyjne (46774 linie; stan po synchronizacji z main 2026-10, doszły running-seats.ts, use-running-seats.ts i entry-config.ts), 89 z nich to komponenty .tsx; 20 komponentów ma ponad 250 linii, 38 ponad 150. Problem nie jest tylko w długości: strony są kontenerem, maszyną stanów fokusu, kalkulatorem layoutu i drzewem JSX naraz. workflow.tsx (679 linii) ma 8 useState, 6 useLayoutEffect, 16 odczytów ze store, 13 inline handlerów i 8-poziomowy ternary na podpowiedź kompozytora; trzy panele (recovery, wynik, sprawdzenia recenzenta) trzymają ten sam stan fokusu skopiowany trzy razy. setup.tsx (729) zawiera trzy komponenty i dwa czyste planery; composer.tsx (787) trzyma kolejkę wklejania obrazów, zapis szkicu, wysyłkę i 28 propsów, z których 4 służą tylko ekranowi home. Te same wzorce UI są pisane ręcznie wiele razy: ramka menu inline (stop, wynik, sprawdzenia), host przygotowania narzędzi (home, setup, session-preparation), lustrzany ref na odczyt klawiszy w tym samym stdin (4 miejsca), legendy klawiszy budowane trzema stylami w 13 plikach, nagłówki sekcji listy (5 miejsc), mapowanie akcji przewijania (3 kopie). Kolejność: najpierw prymitywy o niskim ryzyku (useKeyState, InlineMenuPanel, czyste byline lead dla InputFooter), potem rozbicie workflow.tsx na hooki i czyste derive, potem setup (bez zmiany reguły: wnętrze idzie do features/crew i features/runners), wspólny host przygotowania, home i composer. Po wykonaniu propozycji pliki ponad 500 linii w tej części spadają z 16 do około 11, ponad 300 z 47 do około 36; reszta ponad 500 to moduły .ts, które ocenia część ui. Decyzje dla właściciela: czy strona rozpuszczona (setup, help, skills) może dostać features/x, czy kompozytor ma dalej znać ekran home, oraz czy wprowadzić limit rozmiaru komponentu jako bramkę.`,
  stats: { files: 282, prodLines: 46774, over300: 47, over500: 16, prefixGroups: 6, duplicates: 9 },
  proposals: [
    {
      id: 'RF_REACT_01',
      kind: 'extract-shared',
      priority: 1,
      effort: 'M',
      risk: 'low',
      title: 'Jeden panel menu inline dla menu stop, menu wyniku i karty sprawdzeń recenzenta',
      why: "StopSheet (stop/sheet.tsx:90-121), ResultMenuBody (result/menu.tsx:103-141) i ReviewChecksCard (review-checks/card.tsx:71-128) rysują tę samą ramkę: Box z borderStyleFor('single'), paddingX 1, tytuł przez fitKeyLegend, pętla layout.options z listRowLead + TextSpans, legenda na dole. Każdy z nich ma własne useStaticSelector z shouldHandleInput: !slashHandoffPending() i własne useInput dla Tab (sheet.tsx:74-88, menu.tsx:58-87, card.tsx:56-69). Generyczny układ to stopMenuLayout w stop/options.ts:78-104, ale importują go też result/options.ts:6 i review-checks/options.ts:6 — nazwa mówi 'stop', a to wspólny układ trzech paneli. Każdy z trzech komponentów sam czyta terminalSizeStore, więc prezentacja i kontener są w jednym pliku i nie da się ich wyrenderować w teście bez store.",
      before: [
        { path: 'src/features/workflow/stop/sheet.tsx', lines: 122, note: 'performStop + StopSheet: ramka, wiersze, useStaticSelector, useInput(tab)' },
        { path: 'src/features/workflow/result/menu.tsx', lines: 142, note: 'ResultMenu + ResultMenuBody: ta sama ramka, findings nad opcjami, useInput(tab)' },
        { path: 'src/features/workflow/review-checks/card.tsx', lines: 129, note: 'ReviewChecksCard: ta sama ramka, lista komend nad opcjami, grace typeahead' },
        { path: 'src/features/workflow/stop/options.ts', lines: 266, note: 'stopMenuLayout (78-104) — w praktyce wspólny układ menu inline' }
      ],
      after: [
        { path: 'src/features/workflow/inline-menu/layout.ts', lines: 45, note: "inlineMenuLayout (dawny stopMenuLayout) + CONSEQUENCE_HANG; typ InlineMenuLayout<Id> = { width; bodyRows; height; options: readonly { row: { id: Id }; parts: readonly (readonly ConversationRowSegment[])[] }[] }" },
        { path: 'src/features/workflow/inline-menu/panel.tsx', lines: 70, note: "InlineMenuPanel — prezentacyjny, bez store. Props: interface InlineMenuPanelProps<Id extends string> { layout: InlineMenuLayout<Id>; title: readonly ConversationRowSegment[]; legend: string; selectedIndex: number; focused: boolean; height?: number | undefined; children?: ReactNode }" },
        { path: 'src/features/workflow/inline-menu/use-keys.ts', lines: 40, note: "useInlineMenuKeys<Row extends { readonly id: string }>(input: { rows: readonly Row[]; focused: boolean; onSelect: (row: Row) => void; onTab: () => void; graceMs?: number | undefined }): { selectedIndex: number } — useStaticSelector + slashHandoffPending + Tab + opcjonalny PROMPT_TYPEAHEAD_GRACE_MS" },
        { path: 'src/features/workflow/stop/sheet.tsx', lines: 55, note: 'kontener: performStop, wiersze, InlineMenuPanel' },
        { path: 'src/features/workflow/result/menu.tsx', lines: 75, note: 'kontener: onSelect z potwierdzeniem Apply, findings jako children' },
        { path: 'src/features/workflow/review-checks/card.tsx', lines: 70, note: 'kontener: lista komend jako children, closeReviewChecksPrompt' }
      ],
      moves: [
        'stopMenuLayout, CONSEQUENCE_HANG (stop/options.ts:78-104) → inline-menu/layout.ts jako inlineMenuLayout; stop/options.ts, result/options.ts, review-checks/options.ts, layout/snapshot.ts, app/screens/workflow.tsx importują nową nazwę',
        'JSX ramki i pętli opcji z sheet.tsx:90-121, menu.tsx:103-141, card.tsx:71-128 → InlineMenuPanel',
        'useStaticSelector + useInput(tab) z trzech plików → useInlineMenuKeys',
        'odczyt terminalSizeStore.cols z trzech komponentów → kontener przekazuje gotowy layout'
      ],
      tests: 'stop/sheet.test.tsx, result/menu.test.tsx, review-checks/card.test.tsx zostają jako testy kontenerów. Przypadki stopMenuLayout ze stop/options.test.ts → inline-menu/layout.test.ts. Nowy inline-menu/panel.test.tsx renderuje panel z samych propsów (ink-testing-library, bez store): fokus/bez fokusu, zawijanie konsekwencji, wysokość. Dziś każdy z trzech paneli da się sprawdzić tylko przez pełny store terminalSizeStore.',
      importers: 7,
      references: [ 'docs/STORES-AND-UI.md:127', 'docs/STORES-AND-UI.md:287', 'docs/STRUCTURE.md:585', 'docs/STRUCTURE.md:586', 'testing/visual/fixtures/overlay-fixtures.ts:1905', 'testing/visual/fixtures/overlay-fixtures.ts:1950' ],
      steps: [
        '1. Utwórz inline-menu/layout.ts: przenieś stopMenuLayout jako inlineMenuLayout, zmień 7 importerów (grep stopMenuLayout).',
        '2. Utwórz InlineMenuPanel z propsami jak wyżej; StopSheet przekazuje focused=true (dziś ma zawsze kolor accent).',
        '3. Utwórz useInlineMenuKeys; ReviewChecksCard przekazuje graceMs, StopSheet onTab=overlayStore.close.',
        '4. Przepisz trzy komponenty na kontener + InlineMenuPanel; zostaw ich nazwy eksportów.',
        '5. npm run typecheck && npm run lint; potem tui-shots dla scenariuszy stop-sheet, result menu i review-checks i porównaj PNG.'
      ],
      risks: "Wizualna tożsamość: StopSheet nie ma stanu 'bez fokusu', ResultMenu ma inny kolor ramki bez fokusu — prop focused musi oddać oba. RecoveryMenu (components/recovery-menu.tsx) nie wchodzi: używa ListViewport z akceleratorami literowymi; może później użyć tylko ramki. Reguła 'start narrow, promote on the second consumer' (docs/STRUCTURE.md:397): panel zostaje w features/workflow, nie w src/components, bo ma jednego konsumenta-feature. Bramki: workflow.test.tsx, testy trzech paneli, tui-shots."
    },
    {
      id: 'RF_REACT_02',
      kind: 'split',
      priority: 1,
      effort: 'L',
      risk: 'medium',
      title: 'Rozbić stronę workflow.tsx na hooki fokusu paneli, czysty layout i regiony JSX',
      why: "app/screens/workflow.tsx ma 679 linii, 68 importów (22 ze stores), 8 useState, 6 useLayoutEffect, 16 odczytów ze store, 13 inline handlerów w JSX i około 80 linii kontynuacji ternary. inputHint (549-565) to ternary na 8 poziomów. Ten sam stan fokusu { key, menu } jest napisany trzy razy: recovery (250-265), wynik (269-280), sprawdzenia recenzenta (286-291), a potem 'below' i 'takeKeys' (447-481) wybierają między nimi. Odpowiadanie na pytania planisty (173-212) czyta configStore i modelCacheStore i woła prepareDraftSubmission. Layout (299-350), ogon transkryptu (352-402) i byline z zegarem Apply (404-430) to czyste obliczenia wewnątrz renderu. docs/STRUCTURE.md:318 mówi, że strona trzyma 'layout math + ScreenShell JSX' — w praktyce trzyma maszynę fokusu czterech paneli.",
      before: [
        { path: 'src/app/screens/workflow.tsx', lines: 679, note: "Drzewo dziś: WorkflowScreen → ScreenShell { header: WorkflowHeader → Header + BuildProgressBlock; footer: Divider + WorkflowFooter(28 propsów) → FeedbackRow, beforeComposer[StopMenu | ResultMenu | ReviewChecksCard], Composer, InputFooter; body: WorkflowBody + Box(prompt) → ApprovalPrompt | QuestionPrompt → RecoveryMenu | PlannerQuestion }. Cała logika fokusu, layoutu, ogona i byline jest w jednej funkcji." }
      ],
      after: [
        { path: 'src/app/screens/workflow.tsx', lines: 150, note: "Drzewo potem: WorkflowScreen (tylko wywołania hooków + JSX) → ScreenShell { header: WorkflowHeader; footer: Divider + WorkflowFooter(beforeComposer=<InlinePanelSlot/>); body: WorkflowBody + <PromptRegion/> }" },
        { path: 'src/features/workflow/hooks/workflow-screen/use-panel-focus.ts', lines: 45, note: "usePanelFocus(input: { open: boolean; key: unknown }): PanelFocus, gdzie interface PanelFocus { readonly focused: boolean; take(): void; release(): void; toggle(): void } — zastępuje trzy kopie (250-291)" },
        { path: 'src/features/workflow/hooks/workflow-screen/use-panels.ts', lines: 130, note: 'useWorkflowPanels: który panel jest otwarty (stop, wynik, sprawdzenia, recovery, pytanie), below/takeKeys (447-481), efekt commandRequest (476-481), onEmptySubmit (539-545), propsy menuFocused/onToggleMenu (578-599), resultMenuStore.setHeight (321-324)' },
        { path: 'src/features/workflow/hooks/workflow-screen/use-question-answer.ts', lines: 75, note: 'answerQuestion, composeAnswer, returnToQuestion (173-212) + structuredQuestion' },
        { path: 'src/features/workflow/hooks/workflow-screen/use-review-selection.ts', lines: 40, note: 'reviewSelected + reset przy zmianie artefaktu + handleReviewBoundaryNavigate (128-168), na useKeyState z RF_REACT_03' },
        { path: 'src/features/workflow/hooks/workflow-screen/use-at-rest-byline.ts', lines: 60, note: 'applySince + useSharedClock + byline + legend (404-430, 482-489)' },
        { path: 'src/features/workflow/layout/screen-layout.ts', lines: 90, note: 'deriveWorkflowScreenLayout: sidebarWidth, railForm, reviewBudgetRows, requestedPromptRows, progressRows, promptRows, promptBoxRows, contentHeight, contentWidth (239-244, 299-350) — czysta funkcja' },
        { path: 'src/features/workflow/conversation-rows/tail-blocks.ts', lines: 55, note: 'buildTranscriptTailBlocks: closedBlock, roundBlock, draftBlock + spacery (352-402) — czysta funkcja' },
        { path: 'src/features/workflow/input-hints.ts', lines: 85, note: '+ composerHintFor(input) — 8-poziomowy ternary z 549-565 jako tablica reguł' },
        { path: 'src/features/workflow/components/panel-slot.tsx', lines: 50, note: 'InlinePanelSlot: StopMenu | ResultMenu | ReviewChecksCard (509-535)' },
        { path: 'src/features/workflow/components/prompt-region.tsx', lines: 60, note: 'PromptRegion: Box z ApprovalPrompt | QuestionPrompt (628-676)' }
      ],
      moves: [
        'stan recoveryFocus/resultFocus/checksFocus + trzy useLayoutEffect (250-291) → usePanelFocus ×3 w useWorkflowPanels',
        'below, takeKeys, commandRequest effect (440-481) → useWorkflowPanels',
        'answerQuestion, composeAnswer, returnToQuestion (173-212) → use-question-answer.ts',
        'reviewSelected, reviewSelectedRef, handleReviewBoundaryNavigate, reset effect (128-168) → use-review-selection.ts',
        'getWorkflowSidebarWidth … getWorkflowContentWidth wywołania (239-350) → layout/screen-layout.ts deriveWorkflowScreenLayout',
        'closedBlock, draftBlock, roundBlock, transcriptTail (352-402) → conversation-rows/tail-blocks.ts',
        'applySince, now, apply, byline, legend (404-430, 482-489) → use-at-rest-byline.ts',
        'inputHint ternary (549-565) → input-hints.ts composerHintFor',
        'JSX beforeComposer (509-535) → components/panel-slot.tsx; JSX prompt box (628-676) → components/prompt-region.tsx'
      ],
      tests: 'workflow.test.tsx (3010 linii) i workflow-closed.test.tsx (585) zostają jako testy strony. Nowe testy czyste bez Ink: layout/screen-layout.test.ts (macierz cols × rows × otwarty panel), conversation-rows/tail-blocks.test.ts, input-hints.test.ts (+ composerHintFor, każda gałąź ternary). usePanelFocus i useWorkflowPanels: test hooka przez mały komponent w ink-testing-library (Tab oddaje fokus, slash zabiera klawisze). Dziś każda z tych gałęzi wymaga pełnego renderu strony z 16 store.',
      importers: 1,
      references: [ 'docs/STRUCTURE.md:318', 'docs/WORKFLOW-CONVERSATION-SCROLL.md:115', 'docs/STORES-AND-UI.md:287', 'docs/HOOKS.md:66', 'testing/visual/fixtures/workflow/projection-chrome.ts:27' ],
      steps: [
        '1. Najpierw RF_REACT_03 (useKeyState) i RF_REACT_01 (InlineMenuPanel).',
        '2. Wyciągnij czyste: deriveWorkflowScreenLayout, buildTranscriptTailBlocks, composerHintFor; strona woła je bez zmiany zachowania.',
        '3. Wyciągnij usePanelFocus i zastąp nim trzy kopie stanu fokusu.',
        '4. Wyciągnij useWorkflowPanels (below, takeKeys, onEmptySubmit, propsy toggle) i use-question-answer, use-review-selection, use-at-rest-byline.',
        '5. Wyciągnij InlinePanelSlot i PromptRegion; strona zostaje z JSX regionów.',
        '6. Zaktualizuj docs/STRUCTURE.md:318, docs/WORKFLOW-CONVERSATION-SCROLL.md:115, docs/STORES-AND-UI.md:287 (takeKeys mieszka w use-panels.ts) i inwentarz docs/HOOKS.md:56-67.',
        '7. typecheck, lint, potem workflow.test.tsx i tui-shots workflow-*.'
      ],
      risks: "Kolejność efektów: resultMenuStore.setHeight (321-324) zależy od requestedPromptRows, więc useWorkflowPanels musi dostać wynik deriveWorkflowScreenLayout. Efekt commandRequest (479-481) celowo ma tylko [commandRequest] w zależnościach — zachować i opisać. Komentarz 131-134 (Ink dostarcza ↓⏎ w jednym odczycie) wymaga synchronicznego refa — dlatego RF_REACT_03 najpierw. Prop drilling WorkflowFooter (28 propsów) → Composer (28 propsów) zostaje; to osobny krok po RF_REACT_08. Pokrywa się z RF_UI_?? dla długości workflow.tsx (jeśli istnieje) — tu podział idzie po odpowiedzialnościach komponentu, nie po liniach."
    },
    {
      id: 'RF_REACT_03',
      kind: 'extract-shared',
      priority: 1,
      effort: 'S',
      risk: 'low',
      title: 'Hook useKeyState zamiast ręcznych lustrzanych refów dla klawiszy z jednego odczytu stdin',
      why: "Ink dostarcza wszystkie klawisze jednego odczytu stdin przed ponownym renderem, więc ⏎ zaraz po ↓ czyta stary stan. Cztery miejsca rozwiązują to ręcznie parą useState + useRef: workflow.tsx:130-134 i 161-168 (reviewSelectedRef), approval-prompt/confirm.tsx:67-73 (trzy pary: reasonInput, confirmStep, selectedIndex), hooks/use-static-selector.ts:44-54 (selectedRef), two-column-picker/use-column-state.ts:44-49 (filterRef, indexRef, sourceRef). Każde miejsce ma własny komentarz o tym samym problemie i każde może zapomnieć zapisać ref przed setState.",
      before: [
        { path: 'src/app/screens/workflow.tsx', lines: 679, note: 'reviewSelected + reviewSelectedRef (130-134, 161-168)' },
        { path: 'src/features/workflow/components/approval-prompt/confirm.tsx', lines: 274, note: '4 useState + 3 lustrzane refy (67-73)' },
        { path: 'src/hooks/use-static-selector.ts', lines: 84, note: 'selectedRef (44-54)' },
        { path: 'src/features/runners/two-column-picker/use-column-state.ts', lines: 125, note: 'filterRef, indexRef, sourceRef (44-49)' }
      ],
      after: [
        { path: 'src/hooks/use-key-state.ts', lines: 30, note: "export function useKeyState<T>(initial: T | (() => T)): readonly [value: T, set: (next: T) => void, latest: () => T] — set zapisuje ref synchronicznie, potem setState; latest() czyta ref. Bez useCallback (reguła zero memoization): latest i set to domknięcia nad refem." }
      ],
      moves: [
        'para reviewSelected/reviewSelectedRef → useKeyState (workflow.tsx, potem use-review-selection.ts z RF_REACT_02)',
        'trzy pary w confirm.tsx → trzy useKeyState',
        'selectedRef w use-static-selector.ts → useKeyState',
        'filterRef/indexRef w use-column-state.ts → useKeyState; sourceRef zostaje zwykłym refem (to nie stan)'
      ],
      tests: 'Nowy src/hooks/use-key-state.test.tsx: ink-testing-library, jeden zapis stdin z ↓ i ⏎ wybiera drugi wiersz. To kontrakt współbieżności, więc test jest potrzebny mimo reguły z docs/HOOKS.md o trywialnych hookach. Istniejące testy use-static-selector, confirm, picker i workflow pokrywają migrację.',
      importers: 0,
      references: [ 'docs/HOOKS.md:42-48' ],
      steps: [
        '1. Dodaj src/hooks/use-key-state.ts i test.',
        '2. Migruj use-static-selector.ts (najwięcej konsumentów, najlepszy test regresji).',
        '3. Migruj confirm.tsx, use-column-state.ts, workflow.tsx.',
        '4. Dodaj wiersz do tabeli Shared w docs/HOOKS.md:42-48.'
      ],
      risks: 'Hook ma konsumentów w 3 feature i w src/hooks, więc spełnia regułę src/hooks/ z docs/HOOKS.md. Ryzyko: miejsce, które dziś zapisuje ref bez setState (selectedRef.current = effectiveIndex przy każdym renderze w use-static-selector.ts:47-48), musi dalej synchronizować ref z wartością pochodną — set w renderze jest zakazany, więc tam latest() liczy się z anchorKey. Bramki: testy pickerów i use-static-selector.'
    },
    {
      id: 'RF_REACT_04',
      kind: 'split',
      priority: 1,
      effort: 'M',
      risk: 'low',
      title: 'InputFooter: czysta funkcja deriveBylineLead zamiast 190 linii segmentów w renderze',
      why: "features/workflow/components/input-footer.tsx ma 328 linii i jeden komponent. Czyta useStores z 7 store plus 4 osobne store.use. Linie 138-308 to czysta budowa segmentów: stageLead, waitingLead, liveLead, interruptedLead, resumingLead, stoppedLead, recoveryStoppedLead, stalledLead, potem ternary na 9 poziomów wybiera lead (228-268), potem dopasowanie kopii kolejki (270-308). React jest potrzebny tylko dla useSpinnerFrame, useStopByline i useCrewDisplayNames. W renderze są dwa Date.now() (162, 218). Test input-footer.test.tsx ma 1334 linie i każdą gałąź sprawdza pełnym renderem Ink.",
      before: [
        { path: 'src/features/workflow/components/input-footer.tsx', lines: 328, note: 'kontener + 190 linii czystej derywacji segmentów byline' },
        { path: 'src/features/workflow/input-footer-byline.ts', lines: 125, note: 'buildInputFooterByline, joinBylineParts, stageFractionText' }
      ],
      after: [
        { path: 'src/features/workflow/display/byline-lead.ts', lines: 170, note: "deriveBylineLead(input: BylineLeadInput): { lead: ConversationRowSegment[]; leadClock?: string; hintText: string | null } — wejście: lifecycle, operations, tasks, recovery, approval, stopByline, liveStatus, frame, now, waiting, buildBlockShown, givenByline" },
        { path: 'src/features/workflow/input-footer-byline.ts', lines: 165, note: '+ fitQueuedByline (270-308): skrót kopii kolejki i ponowna budowa byline' },
        { path: 'src/features/workflow/components/input-footer.tsx', lines: 100, note: 'kontener: odczyty store → BylineLeadInput, useSpinnerFrame, render jednej linii' }
      ],
      moves: [
        'stageParts, stageLead, stageTail, waitingLead, liveLead, interruptedLead, resumingLead, stoppedLead, recoveryStoppedLead, stalledLead, wybór lead (138-268) → display/byline-lead.ts deriveBylineLead',
        'queuedCopy, atRestByline, bylineLead, bylineInput, ponowna budowa (270-308) → input-footer-byline.ts fitQueuedByline',
        'Date.now() (162, 218) → parametr now w BylineLeadInput'
      ],
      tests: 'Macierz gałęzi z input-footer.test.tsx przechodzi do display/byline-lead.test.ts (czyste, bez Ink, now podane jawnie). W input-footer.test.tsx zostaje około 10 testów renderu (checkingStage, szerokość, kolejka). Szybszy i deterministyczny test zegara.',
      importers: 1,
      references: [ 'CLAUDE.md:162', 'docs/STRUCTURE.md:310', 'docs/STORES-AND-UI.md:169', 'docs/STORES-AND-UI.md:209', 'docs/STORES-AND-UI.md:227', 'docs/ARCHITECTURE.md:758' ],
      steps: [
        '1. Zdefiniuj BylineLeadInput w display/byline-lead.ts; przenieś budowę segmentów bez zmian treści.',
        '2. Przenieś dopasowanie kolejki do input-footer-byline.ts.',
        '3. InputFooter składa wejście ze store i woła obie funkcje.',
        '4. Przenieś testy gałęzi; CLAUDE.md:162 dopisz deriveBylineLead obok deriveLiveStatus.'
      ],
      risks: 'Byline odświeża się dziś przez rerender spinnera; now = Date.now() w miejscu wywołania zachowuje to zachowanie. Kopia zmienia się w zero miejsc (tylko przeniesienie), więc tui-shots workflow-* muszą dać identyczne PNG.'
    },
    {
      id: 'RF_REACT_05',
      kind: 'split',
      priority: 1,
      effort: 'M',
      risk: 'medium',
      title: 'setup.tsx: czyste planery, CrewStep i panel discovery do domen crew i runners',
      why: "app/screens/setup.tsx ma 729 linii, 53 importy, 20 odczytów ze store, 4 efekty, 2 useInput i trzy komponenty w jednej stronie: DiscoveryPanel (223-288), CrewStep (290-498, 209 linii z własnym efektem dostępności i listą) i SetupScreen (500-729). Czyste planery: LADDER/planStage/planSetupList (107-167), sectionOf/crewKeysHint/continueText (169-200). Asynchroniczne sprawdzenie dostępności withCliCatalogs/unavailableSetupSeats (81-100) jest wołane dwa razy: w efekcie CrewStep (325-337) i w finalize (636-674). Panel discovery setup (258-272) i stan cold discovery w app/overlays/runners.tsx:82-88 to ten sam OverlayPanel(BOOT_MANIFEST_TITLE, density compact) + BootManifest. Dwie różne komponenty nazywają się DiscoveryPanel (setup.tsx:231 i home.tsx:101).",
      before: [
        { path: 'src/app/screens/setup.tsx', lines: 729, note: 'DiscoveryPanel, CrewStep, SetupScreen, planery listy, sprawdzenie dostępności, finalize' },
        { path: 'src/app/overlays/runners.tsx', lines: 165, note: 'cold discovery panel (82-88) — duplikat panelu z setup' }
      ],
      after: [
        { path: 'src/app/screens/setup.tsx', lines: 140, note: 'SetupScreen: krok, przygotowanie (RF_REACT_07), wybór panelu' },
        { path: 'src/features/crew/setup/list-plan.ts', lines: 110, note: 'SetupItem, LADDER, planStage, planSetupList, sectionOf, crewKeysHint, continueText, PRESET_SECTION — czyste' },
        { path: 'src/features/crew/setup/availability.ts', lines: 40, note: 'withCliCatalogs, unavailableSetupSeats' },
        { path: 'src/features/crew/setup/use-seat-availability.ts', lines: 50, note: 'stan availability + efekt z AbortController (310-337)' },
        { path: 'src/features/crew/setup/use-finalize.ts', lines: 70, note: "finalize (636-674) + saveCheck ref; przyjmuje onStartWorkflow, więc crew nie importuje start-preparation" },
        { path: 'src/features/crew/setup/crew-step.tsx', lines: 140, note: 'CrewStep: budżet wierszy, useFilterableList, ListViewport' },
        { path: 'src/features/crew/setup/item-row.tsx', lines: 70, note: "SetupItemRow — prezentacyjny switch z renderItem (445-493): preset, crew + 'Unavailable', continue" },
        { path: 'src/features/runners/cold-discovery-panel.tsx', lines: 75, note: "ColdDiscoveryPanel({ state: 'initializing' | 'failed'; hint: string; footer?: ReactNode; onRetry?; onOpenSettings? }) — dla setup i runners.tsx" }
      ],
      moves: [
        'LADDER, SetupListPlan, SetupListInput, planStage, planSetupList, SetupItem, sectionOf, crewKeysHint, continueText, PRESET_SECTION, CREW_SECTION, CONTINUE_SECTION → features/crew/setup/list-plan.ts',
        'withCliCatalogs, unavailableSetupSeats → features/crew/setup/availability.ts',
        'CrewStep (290-498) → features/crew/setup/crew-step.tsx; renderItem switch → item-row.tsx',
        'finalize → features/crew/setup/use-finalize.ts',
        'DiscoveryPanel (223-288) + runners.tsx:82-88 → features/runners/cold-discovery-panel.tsx'
      ],
      tests: 'setup.test.tsx (1677 linii) zostaje testem strony; import PRESET_SECTION (setup.test.tsx:48) zmienia się na list-plan.js. Nowe: features/crew/setup/list-plan.test.ts (drabina LADDER przy różnych budżetach, bez Ink), availability.test.ts, item-row.test.tsx (render z propsów). ColdDiscoveryPanel dostaje test renderu; runners.test.tsx pokrywa drugi konsument.',
      importers: 2,
      references: [ 'CLAUDE.md:155', 'docs/STRUCTURE.md:62', 'docs/STRUCTURE.md:339', 'docs/STRUCTURE.md:424', 'docs/STRUCTURE.md:574', 'docs/STORES-AND-UI.md:153', 'docs/STORES-AND-UI.md:305', 'docs/INVARIANTS.md:48', 'docs/INVARIANTS.md:53', 'scripts/invariants/gates.ts:242', 'scripts/invariants/gates.ts:276' ],
      steps: [
        '1. Przenieś czyste list-plan.ts i availability.ts; dodaj testy.',
        '2. Przenieś CrewStep i SetupItemRow do features/crew/setup/; strona importuje je jak dziś importuje CrewRowView.',
        '3. Wyciągnij useSeatAvailability i useSetupFinalize (callback onStartWorkflow z RF_REACT_07).',
        '4. Utwórz ColdDiscoveryPanel w features/runners; użyj go w setup.tsx i runners.tsx.',
        '5. Bramka 46 (isSmall): dopisz src/features/crew/setup do listy ścieżek w scripts/invariants/gates.ts:276 i docs/INVARIANTS.md:53, bo dziś lista obejmuje src/app/screens/setup.tsx. Bramka 31 już obejmuje src/features/crew i src/features/runners.',
        '6. Zaktualizuj docs/STRUCTURE.md:339 i :424 (setup komponuje features/crew/setup).'
      ],
      risks: "Reguła blokuje prostsze rozwiązanie: features/setup/ nie może istnieć, bo setup jest 'rozpuszczony' (CLAUDE.md:155, docs/STRUCTURE.md:62, :337-339), a nawet gdyby istniał, features/setup nie może importować features/crew i features/runners (scripts/import-boundaries.ts:123). Dlatego wnętrze idzie do domeny crew (setup to wybór załogi) i runners (discovery narzędzi) — bez zmiany reguły. Decyzja dla właściciela w odpowiedzi końcowej. Bramki: 9 (import-boundaries), 31, 46, setup.test.tsx, tui-shots setup-initial."
    },
    {
      id: 'RF_REACT_06',
      kind: 'split',
      priority: 2,
      effort: 'M',
      risk: 'low',
      title: 'home.tsx: panel sprawdzania narzędzi, czysta podpowiedź home i stan layoutu poza stroną',
      why: "app/screens/home.tsx ma 448 linii, 50 importów, 9 odczytów ze store, 4 efekty, 1 useInput. Wewnątrz strony siedzi komponent DiscoveryPanel (88-171, 84 linie ze stałymi), czysta derywacja podpowiedzi i powiadomienia (322-356) jako let + if/else, para getHomeLayout dla stanu z fokusem i bez (235-264) z obliczeniem discoveryPanelFits, oraz efekt odpytywania sessionsStore/configStore co LOCKFILE_PING_INTERVAL_MS (271-281).",
      before: [
        { path: 'src/app/screens/home.tsx', lines: 448, note: "Drzewo dziś: HomeScreen → [StartPreparationPanel] + Box → ScreenShell → logo, HomeSeatBlock, notice, RecentSessions, błąd, DiscoveryPanel (inline), Composer(home props)" },
        { path: 'src/features/home/layout.ts', lines: 166, note: 'getHomeLayout, NO_CONFIG_NOTICE' }
      ],
      after: [
        { path: 'src/app/screens/home.tsx', lines: 170, note: 'Drzewo potem: HomeScreen → [PreparationGate] + Box → ScreenShell → logo, HomeSeatBlock, notice, RecentSessions, SelectionError, ToolCheckBox, Composer' },
        { path: 'src/features/home/components/tool-check-box.tsx', lines: 85, note: 'ToolCheckBox (dawny DiscoveryPanel z home) + DISCOVERY_PANEL_* stałe' },
        { path: 'src/features/home/hint.ts', lines: 55, note: "deriveHomeComposerHint(input: { interactionBlocked; canFocus; sessionsActive; hintNotice; toolCheck; refreshFrame }): { homeHint?: string; homeNotice?: HomeNotice } + DEFAULT_HOME_HINT, HOME_HINT — czyste" },
        { path: 'src/features/home/layout.ts', lines: 200, note: '+ deriveHomeLayoutState: preliminary/focused layout, canFocus, sessionsActive, renderedSessionRows, discoveryPanelFits (235-264)' },
        { path: 'src/features/home/use-home-refresh.ts', lines: 20, note: 'efekt odświeżania sesji i configu (271-281)' }
      ],
      moves: [
        'DiscoveryPanel + DISCOVERY_PANEL_MIN_ROWS/SLACK_ROWS/CHROME_COLS (88-171) → features/home/components/tool-check-box.tsx jako ToolCheckBox',
        'homeHint/homeNotice (322-348) → features/home/hint.ts deriveHomeComposerHint',
        'preliminaryLayout, focusedLayout, hasRoomForSessions, canFocus, sessionsActive, renderedSessionRows, discoveryPanelFits (235-264) → layout.ts deriveHomeLayoutState',
        'useEffect refresh (271-281) → use-home-refresh.ts',
        'useStartPreparation config, Esc cancel, sprzątanie promptu (192-224, 293-298, 315-320, 353-356, 360-367) → RF_REACT_07'
      ],
      tests: 'home.test.tsx (2152 linii) zostaje. Nowe czyste: features/home/hint.test.ts (każda kombinacja toolCheck × fokus), rozszerzenie layout.test.ts o deriveHomeLayoutState. tool-check-box.test.tsx renderuje trzy stany (cold, failed, not-run) z propsami.',
      importers: 2,
      references: [ 'docs/STORES.md:190', 'docs/design/tui-concepts/README.md:37', 'docs/INVARIANTS.md:53', 'scripts/invariants/gates.ts:276' ],
      steps: [
        '1. Przenieś ToolCheckBox; nazwa usuwa kolizję z DiscoveryPanel w setup.',
        '2. Dodaj deriveHomeComposerHint i deriveHomeLayoutState z testami.',
        '3. Dodaj useHomeRefresh.',
        '4. Bramka 46: dopisz src/features/home/hint.ts i src/features/home/components/tool-check-box.tsx do listy isSmall, jeśli mają wybór szerokości (dziś lista ma tylko home.tsx i features/home/layout.ts).',
        '5. tui-shots home-* i porównanie.'
      ],
      risks: 'Hook start-preparation nie może zamieszkać w features/home (features/home → features/start-preparation jest zabronione przez scripts/import-boundaries.ts:123), dlatego część przygotowania idzie do src/app w RF_REACT_07. docs/STORES.md:190 cytuje overlayStore.use(s => s.active !== ...) z home.tsx jako przykład — po RF_REACT_11 przykład trzeba zmienić.'
    },
    {
      id: 'RF_REACT_07',
      kind: 'extract-shared',
      priority: 2,
      effort: 'S',
      risk: 'low',
      title: 'Wspólny host przygotowania narzędzi dla home, setup i session-preparation',
      why: "Trzy strony powtarzają ten sam blok: StartPreparationPanel + render prop ApprovalPrompt + onOpenSettings=overlayStore.open('settings') (home.tsx:360-367, setup.tsx:676-685, session-preparation.tsx:50-61); useInput z Esc anulującym próbę (home.tsx:315-320, setup.tsx:629-634, session-preparation.tsx:41-46); sprzątanie closeApprovalPrompt przy odmontowaniu (home.tsx:293-298, setup.tsx:602-608). Home i setup budują ten sam prepare (prepareExecution z interactivePreparationPolicy i purpose 'new-workflow') i ten sam onPrepared (routerStore.navigate do workflow z readRunRecord) — home.tsx:192-224, setup.tsx:540-567. Tekst statusu `${frame} ${stage} · esc cancel` jest napisany dwa razy (home.tsx:353-356, setup.tsx:711-714).",
      before: [
        { path: 'src/app/screens/home.tsx', lines: 448, note: 'prepare/onPrepared, Esc, sprzątanie, panel, status' },
        { path: 'src/app/screens/setup.tsx', lines: 729, note: 'prepare/onPrepared, Esc, sprzątanie, panel, status' },
        { path: 'src/app/session-preparation.tsx', lines: 62, note: 'Esc, sprzątanie, panel' }
      ],
      after: [
        { path: 'src/app/prepare-start.ts', lines: 50, note: "newWorkflowPreparation(input: { prepareExecution; readRunRecord; onStarted?: () => void }): StartPreparationOptions<NewWorkflowRequest>, gdzie NewWorkflowRequest = { projectDir; feature; plannerContext?; attachedInputs?; allowRepoRunners }" },
        { path: 'src/app/preparation-gate.tsx', lines: 40, note: "PreparationGate({ state: StartPreparationState; onRetry: () => void; onBack: () => void }) — panel + ApprovalPrompt + otwarcie Settings" },
        { path: 'src/features/start-preparation/use-cancel-key.ts', lines: 15, note: 'usePreparationCancelKey({ active: boolean; onCancel: () => void })' },
        { path: 'src/features/start-preparation/status.ts', lines: 15, note: 'preparationStatusText({ frame; stage; cancellable }): string' },
        { path: 'src/features/start-preparation/use-close-prompt-on-leave.ts', lines: 15, note: "zamyka prompt przy odmontowaniu, gdy sessionSelectStore.preparation.kind === 'idle'" }
      ],
      moves: [
        'prepare + onPrepared z home.tsx:192-224 i setup.tsx:540-567 → app/prepare-start.ts newWorkflowPreparation (home przekazuje onStarted=saveHomeDraft pusty)',
        'StartPreparationPanel + ApprovalPrompt JSX z trzech stron → app/preparation-gate.tsx',
        'useInput Esc z trzech stron → usePreparationCancelKey',
        'tekst statusu z home.tsx:353-356 i setup.tsx:711-714 → preparationStatusText',
        'efekty odmontowania z home.tsx:293-298 i setup.tsx:602-608 → useClosePromptOnLeave'
      ],
      tests: 'Nowy app/prepare-start.test.ts (prepare odrzuca brak configu, onPrepared nawiguje) bez Ink. preparation-gate pokrywają testy stron. use-start-preparation.test.tsx bez zmian.',
      importers: 3,
      references: [ 'docs/STRUCTURE.md:452' ],
      steps: [
        '1. Dodaj status.ts, use-cancel-key.ts, use-close-prompt-on-leave.ts w start-preparation.',
        '2. Dodaj app/prepare-start.ts i app/preparation-gate.tsx (helpery app jak prepare-resume.ts i session-preparation.tsx).',
        '3. Migruj home, setup, session-preparation.',
        '4. Dopisz oba helpery do docs/STRUCTURE.md:452.'
      ],
      risks: "PreparationGate musi być w src/app, nie w features/start-preparation, bo ApprovalPrompt mieszka w features/workflow, a feature nie importuje feature (dlatego dziś panel dostaje render prop). Bramka 9 pilnuje tylko root/router/provider/layout, więc strony mogą importować nowe helpery app. Alternatywa do decyzji: przenieść ApprovalPrompt (approval-prompt.tsx + approval-prompt/*) do własnego feature features/approval — dziś renderują go home, setup, workflow i session-preparation (5 importerów), ale ciągnie prompt-rows/approval.ts (9 importerów) i layout/chrome-rows.ts z workflow."
    },
    {
      id: 'RF_REACT_08',
      kind: 'split',
      priority: 2,
      effort: 'L',
      risk: 'medium',
      title: 'Composer: hooki wklejania obrazu, szkicu i wysyłki; prezentacyjne wiersze podpowiedzi i nakładki',
      why: "components/composer/composer.tsx ma 787 linii, 52 importy (14 ze stores), 28 propsów, 5 useState, 7 efektów. ComposerInput (188-787) trzyma: kolejkę wklejania obrazów ze schowka (ImagePaste 81-94, finishImagePaste 390-431, dwa efekty 433-474, enqueue/handleImagePaste 476-496), zapis i przywracanie szkicu sesji (233-272), walidację załączników (canAttachImage, handleFileDrop 352-388), wysyłkę i historię (send, handleSubmit 498-570), bramkę klawiszy (shouldHandleInput 719-740, commandsOnlyGate 576-581), obliczenia wierszy podpowiedzi i nakładek (597-648), trzy efekty publikujące stan do store (650-664) i JSX (666-786). Cztery propsy (homeHint, homeStatus, homeNotice, submitKeepsDraft) służą tylko ekranowi home, a reserveHomeHint = currentScreen === 'home' (627) rysuje wiersz home w komponencie współdzielonym.",
      before: [
        { path: 'src/components/composer/composer.tsx', lines: 787, note: 'Drzewo dziś: Composer → ComposerInput → [wiersze podpowiedzi home], Box(ramka) → MultilineInput (25 propsów, inline shouldHandleInput), CommandCompletionMenu, ReferenceCompletionMenu' }
      ],
      after: [
        { path: 'src/components/composer/composer.tsx', lines: 260, note: 'Drzewo potem: Composer → ComposerInput → HomeHintRow?, ComposerBox → MultilineInput, CompletionOverlay' },
        { path: 'src/components/composer/use-image-paste.ts', lines: 150, note: 'ImagePaste, CLIPBOARD_IMAGE_ERRORS, kolejka, finishImagePaste, efekty odczytu, enqueueImagePaste, handleImagePaste; zwraca { enqueue, onCtrlV, pending, abortAll }' },
        { path: 'src/components/composer/use-attach-image.ts', lines: 50, note: 'canAttachImage, handleFileDrop' },
        { path: 'src/components/composer/use-restored-draft.ts', lines: 60, note: 'restoredDraft, zapis przy zmianie, flush przy odmontowaniu (233-272)' },
        { path: 'src/components/composer/use-composer-send.ts', lines: 90, note: 'send, handleSubmit, rozliczenie obrazów w attachmentsStore i historii (498-570)' },
        { path: 'src/components/composer/key-gate.ts', lines: 40, note: "composerKeyAction(input, key, ctx): 'send-now' | 'tab' | 'paste-image' | 'refuse' | 'pass' — czysta wersja shouldHandleInput + commandsOnlyGate" },
        { path: 'src/components/composer/home-hint-row.tsx', lines: 35, note: 'HomeHintRow({ feedbackRows; feedbackIsError; hintLine; tone; height }) — prezentacyjny (668-687)' },
        { path: 'src/components/composer/completion/overlay.tsx', lines: 40, note: 'CompletionOverlay: pozycjonowanie absolute obu menu (765-783)' }
      ],
      moves: [
        'ImagePaste, CLIPBOARD_IMAGE_ERRORS, pasteQueueRef, imagePaste/imagePasteResult, finishImagePaste, dwa efekty, enqueueImagePaste, handleImagePaste → use-image-paste.ts',
        'canAttachImage, handleFileDrop → use-attach-image.ts',
        'restoredDraft, usePasteDrafts onDocumentChange, efekt flushSessionDrafts → use-restored-draft.ts',
        'send, handleSubmit, submittedImageIdsRef → use-composer-send.ts',
        'shouldHandleInput (719-740) + commandsOnlyGate (576-581) → key-gate.ts composerKeyAction',
        'JSX 668-687 → home-hint-row.tsx; JSX 765-783 → completion/overlay.tsx'
      ],
      tests: 'composer.test.tsx, session-draft.test.tsx, refused-send.test.tsx, review-keys.test.tsx, composer.backspace.test.tsx zostają jako testy zachowania. Nowe: key-gate.test.ts (macierz klawisz × tryb, bez Ink), use-image-paste test kolejki z wstrzykniętym readClipboardImage (kolejność, przerwanie przy zmianie trybu). Dziś kolejka wklejania jest testowalna tylko przez pełny render kompozytora.',
      importers: 2,
      references: [ 'CLAUDE.md:152', 'docs/STRUCTURE.md:435', 'docs/ARCHITECTURE.md:791' ],
      steps: [
        '1. key-gate.ts (czyste) + test.',
        '2. use-restored-draft.ts, use-attach-image.ts, use-image-paste.ts — w tej kolejności, każde z pełnym testem kompozytora.',
        '3. use-composer-send.ts.',
        '4. HomeHintRow i CompletionOverlay.',
        '5. Decyzja właściciela o propsach home (patrz risks), potem ewentualnie slot.'
      ],
      risks: "useEffectEvent (finishImagePaste) i kolejność efektów obrazu muszą zostać w jednym hooku. Propsy home: lepszy projekt to slot hintRow, ale composer liczy dockRows z wierszy podpowiedzi (646-652) i publikuje je do inputHeightStore, z którego home planuje layout — slot wymaga, żeby home podał liczbę wierszy. To decyzja dla właściciela. CLAUDE.md:152 (composer w src/components/composer) jest zachowane. Pokrywa się z RF_UI_?? dla długości composer.tsx (jeśli istnieje)."
    },
    {
      id: 'RF_REACT_09',
      kind: 'split',
      priority: 2,
      effort: 'S',
      risk: 'low',
      title: 'Settings: wiersz ustawienia, blok pomocy i okno listy jako osobne moduły',
      why: "app/overlays/settings.tsx ma 280 linii, 35 importów i jeden komponent z 23 elementami JSX. renderItem (197-245) zawiera inline wiersz edycji wartości (216-231) i wiersz ListRow; blok pomocy (260-275) liczy spacer i wiersze; okno listy (76-123: listBudget, pinnedHead, windowInput, getPageSize, canActOnIndex), detail (161-172) i hint (150-156) to czyste obliczenia w renderze.",
      before: [ { path: 'src/app/overlays/settings.tsx', lines: 280, note: 'SettingsOverlay → OverlayPanel → FilterInput, ListViewport(renderItem inline), help block inline, FeedbackNotice' } ],
      after: [
        { path: 'src/app/overlays/settings.tsx', lines: 140, note: 'SettingsOverlay → OverlayPanel → FilterInput, ListViewport(renderItem → CrewRowView | FallbackRowView | SettingRowView), SettingsHelpBlock, FeedbackNotice' },
        { path: 'src/features/settings/setting-row.tsx', lines: 60, note: "SettingRowView({ label: string; value: unknown; def: SettingDef; editing: boolean; editBuffer: string; isCursor: boolean; width: number; detectedContextLength: number | null }) — prezentacyjny" },
        { path: 'src/features/settings/help-block.tsx', lines: 40, note: 'SettingsHelpBlock({ label; rows; width }) + DESCRIPTION_ROWS' },
        { path: 'src/features/settings/list-window.ts', lines: 70, note: 'settingsListWindow, settingsDetail, settingsHint — czyste' }
      ],
      moves: [ 'renderItem gałąź ustawienia (212-244) → setting-row.tsx', 'help JSX (260-275) + helpSpacerRows (176) → help-block.tsx', 'listBudget … canActOnIndex (76-123), detail (161-172), hintText (150-156) → list-window.ts' ],
      tests: 'settings.test.tsx (814 linii) zostaje. Nowe: list-window.test.ts (pinnedHead, widoczność wiersza, budżet przy 60x18), setting-row.test.tsx (edycja, boolean, metadane).',
      importers: 1,
      references: [ 'docs/STRUCTURE.md:320', 'docs/STRUCTURE.md:333' ],
      steps: [ '1. list-window.ts + test.', '2. setting-row.tsx i help-block.tsx.', '3. Uaktualnij anatomię settings w docs/STRUCTURE.md:320-333.', '4. tui-shots overlay-settings*.' ],
      risks: 'Niskie. Bramka 31 obejmuje src/features/settings i settings.tsx, więc przeniesienie nie traci pokrycia.'
    },
    {
      id: 'RF_REACT_10',
      kind: 'extract-shared',
      priority: 2,
      effort: 'M',
      risk: 'low',
      title: 'Jedna gramatyka legendy klawiszy w core/key-legend.ts zamiast trzech stylów w 13 plikach',
      why: "Komentarz w prompt-rows/approval.ts:45 mówi 'One legend grammar everywhere', ale KeyHint, formatKeyHints, SELECT_HINT, CONFIRM_HINT, DENY_HINT (approval.ts:40-61) mieszkają w features/workflow, więc src/components i inne feature nie mogą ich użyć. Skutek: legendy z '↑↓ select' są budowane trzema stylami w 13 plikach — tablica .join(SOFT_SEP) (palette.tsx:175-176, completion/command/menu.tsx:40, completion/reference/menu.tsx:26), template literal z SOFT_SEP (settings.tsx:155-156, skills.tsx:147, setup.tsx:403, recent-sessions-list.tsx:17, local-connection-form.tsx:488, contract-choice-overlay.tsx:135) i gotowy string z ' · ' (stop/options.ts:38-39, result/options.ts:24, review-checks/options.ts:16). fitKeyLegend już jest w core/key-legend.ts.",
      before: [
        { path: 'src/features/workflow/prompt-rows/approval.ts', lines: 556, note: 'KeyHint, formatKeyHints, SELECT_HINT, CONFIRM_HINT, DENY_HINT (40-61)' },
        { path: 'src/core/key-legend.ts', lines: 23, note: 'KEY_LEGEND_LEADING, fitKeyLegend' }
      ],
      after: [
        { path: 'src/core/key-legend.ts', lines: 60, note: "+ interface KeyHint { key: string; verb: string }, formatKeyHints(hints: readonly KeyHint[]): string, SELECT_HINT, CONFIRM_HINT, DENY_HINT, CLOSE_HINT ({ key: 'esc', verb: 'close' }), TAB_HINT(verb)" },
        { path: 'src/features/workflow/prompt-rows/approval.ts', lines: 535, note: 'importuje z core/key-legend.ts; zostają legendy specyficzne dla bramek (CHOOSE_HINTS, CONFIRM_NUDGE)' }
      ],
      moves: [ 'KeyHint, formatKeyHints, SELECT_HINT, CONFIRM_HINT, DENY_HINT → core/key-legend.ts', '13 plików z ręcznymi legendami → formatKeyHints([...]) z tymi samymi słowami' ],
      tests: 'core/key-legend.test.ts dostaje formatKeyHints. Testy 13 powierzchni i tui-shots muszą dać identyczny tekst — to przeniesienie bez zmiany kopii.',
      importers: 9,
      references: [],
      steps: [ '1. Przenieś typy i stałe do core/key-legend.ts; approval.ts reeksportu nie robi (zero barrels) — 2 importerów (recovery-menu.tsx, planner-question.tsx) zmienia import.', '2. Migruj pliki po jednym; porównuj string przed i po w teście.', '3. npm run tui-shots dla overlay-*, setup-initial, workflow-* i porównanie.' ],
      risks: 'Kopia widoczna dla użytkownika musi zostać bajt w bajt (bramka 59 nie dotyczy, ale testy kopii tak). core nie importuje features — kierunek jest poprawny (features → core).'
    },
    {
      id: 'RF_REACT_11',
      kind: 'extract-shared',
      priority: 3,
      effort: 'S',
      risk: 'low',
      title: 'Nazwane selektory selectHasOverlay i selectCheckingStage zamiast 11 kopii lambdy',
      why: "Lambda overlayStore.use((s) => s.active !== 'none') stoi w 8 miejscach (session-preparation.tsx:28, home.tsx:181, setup.tsx:233, :306, :530, approval-prompt.tsx:47, workflow-screen/use-model.ts:77, start-preparation/panel.tsx:292). preparationStore.use((state) => state.kind === 'checking' ? state.stage : null) stoi w 3 (home.tsx:231, setup.tsx:534, input-footer.tsx:103). Projekt ma już wzorzec nazwanych selektorów (isOpenRunAtRest w router.ts, selectRunningBrief w tasks.ts, selectScheduledReview w operations). Selektor to funkcja, nie hook, więc reguła 'nie owijaj store.use w hook' (docs/STORES.md) jest zachowana.",
      before: [ { path: 'src/stores/ui/overlay.ts', lines: 37, note: 'overlayStore' }, { path: 'src/stores/navigation/preparation.ts', lines: 176, note: 'preparationStore' } ],
      after: [ { path: 'src/stores/ui/overlay.ts', lines: 40, note: '+ export const selectHasOverlay = (s: OverlayState): boolean' }, { path: 'src/stores/navigation/preparation.ts', lines: 180, note: '+ export const selectCheckingStage = (s: PreparationState): string | null' } ],
      moves: [ '8 lambd → overlayStore.use(selectHasOverlay)', '3 lambdy → preparationStore.use(selectCheckingStage)' ],
      tests: 'Bez nowych testów; istniejące testy stron. Selektor stabilny po referencji poprawia cache getSnapshot w create-store.',
      importers: 11,
      references: [ 'docs/STORES.md:190' ],
      steps: [ '1. Dodaj selektory.', '2. Zamień 11 miejsc.', '3. Zmień przykład w docs/STORES.md:190 (dotyczy wyboru selector vs useStores).' ],
      risks: 'Niskie. Przykład w docs/STORES.md:190 jest celowo o selektorze warunkowym — po zmianie przykład dalej działa jako selektor nazwany.'
    },
    {
      id: 'RF_REACT_12',
      kind: 'extract-shared',
      priority: 3,
      effort: 'S',
      risk: 'low',
      title: 'ListViewport: domyślny nagłówek sekcji ListGroupHeader',
      why: "Pięć list z sekcjami podaje renderHeader ręcznie: palette.tsx:199, settings.tsx:191, setup.tsx:433 i skills.tsx:207 rysują inline <Text color={t.textDim}>{label}</Text>, a help.tsx:174 używa istniejącego ListGroupHeader (list-row.tsx:325-334), który dodatkowo obcina etykietę i usuwa znaki sterujące. Te same nagłówki wyglądają więc na dwa sposoby, a cztery miejsca nie sanitują etykiety.",
      before: [ { path: 'src/components/pickers/list-viewport.tsx', lines: 236, note: 'section.renderHeader wymagany' } ],
      after: [ { path: 'src/components/pickers/list-viewport.tsx', lines: 238, note: 'section.renderHeader?: (section: string, index: number) => ReactNode; domyślnie (label) => <ListGroupHeader label={label} />' } ],
      moves: [ 'inline renderHeader z palette, settings, setup → usunięte (domyślny)', 'skills.tsx:207 → mapowanie etykiety w section.by, nagłówek domyślny' ],
      tests: 'list-viewport.test.tsx: przypadek domyślnego nagłówka. tui-shots overlay-palette*, overlay-settings*, overlay-skills*, setup-initial.',
      importers: 7,
      references: [],
      steps: [ '1. renderHeader opcjonalny z domyślnym ListGroupHeader.', '2. Usuń 4 inline nagłówki.', '3. Renderuj i porównaj.' ],
      risks: 'ListGroupHeader ma height 1 i truncate — nagłówek dłuższy niż kolumna dziś się zawija, po zmianie się obetnie. Sprawdzić w tui-shots.'
    },
    {
      id: 'RF_REACT_13',
      kind: 'split',
      priority: 3,
      effort: 'S',
      risk: 'medium',
      title: 'Render bez store.get(): wiersze menu stop z selektorów zamiast subskrypcji bez odczytu',
      why: "StopMenu (stop/menu.tsx:11) woła useStores(tasksStore, stopStore, routerStore, lifecycleStore, recoveryNoticeStore) i nie czyta żadnego pola — to tylko subskrypcja, żeby readStopMenuRows() (stop/options.ts:150) mógł w renderze czytać stopStore.get(), routerStore.get() i activeApply(). To samo robi workflow.tsx:123 useStores(stopStore, tasksStore). Lista subskrypcji musi ręcznie odpowiadać liście .get() w innym pliku. Podobne subskrypcje bez użycia wartości: usage.tsx:29-30 (operationsStore, modelCacheStore) i settings.tsx:66 (detectionStore.cliCatalogOutcomes).",
      before: [ { path: 'src/features/workflow/stop/options.ts', lines: 266, note: 'readStopMenuRows (150), readStopSheetFooter (264) czytają store przez .get()' }, { path: 'src/features/workflow/stop/menu.tsx', lines: 14, note: 'subskrypcja bez odczytu' } ],
      after: [
        { path: 'src/features/workflow/stop/options.ts', lines: 270, note: 'stopMenuRows(input: StopMenuInput) czyste; readStopMenuRows() = stopMenuRows(readStopMenuInput()) zostaje dla layout/snapshot.ts (kod nie-React)' },
        { path: 'src/features/workflow/stop/use-stop-menu-rows.ts', lines: 35, note: 'useStopMenuRows(): StopRow[] — selektory store → StopMenuInput → stopMenuRows' },
        { path: 'src/features/workflow/stop/menu.tsx', lines: 12, note: 'StopSheet rows={useStopMenuRows()}' }
      ],
      moves: [ 'odczyty .get() z readStopMenuRows → readStopMenuInput + selektory w useStopMenuRows', 'useStores bez odczytu w menu.tsx:11 i workflow.tsx:123 → usunięte' ],
      tests: 'stop/options.test.ts testuje stopMenuRows z jawnym wejściem, bez ustawiania pięciu store.',
      importers: 7,
      references: [ 'docs/SLASH-COMMANDS-REFERENCE.md:148' ],
      steps: [ '1. Zdefiniuj StopMenuInput i stopMenuRows.', '2. Dodaj useStopMenuRows.', '3. Usuń subskrypcje bez odczytu.', '4. Uaktualnij docs/SLASH-COMMANDS-REFERENCE.md:148.' ],
      risks: "activeApply() (engine/orchestrator/session-lifecycle/shutdown.ts) to stan modułu, nie store — nie da się go subskrybować selektorem. Dziś rerender przy jego zmianie daje przypadkowa subskrypcja; po zmianie trzeba subskrybować onActiveApplyChange albo zostawić jedną jawną subskrypcję z komentarzem. Dlatego ryzyko medium."
    },
    {
      id: 'RF_REACT_14',
      kind: 'move',
      priority: 3,
      effort: 'S',
      risk: 'low',
      title: 'FramePanel do src/components — ma konsumentów w dwóch feature',
      why: "features/workflow/components/frame-panel.tsx (75 linii; od ff47a03 sam liczy ścieżkę od korzenia projektu z configStore i skraca ją w środku) jest używany przez app/overlays/editor.tsx (powierzchnia feature editor) i workflow/components/review-view.tsx. docs/STRUCTURE.md:614 opisuje to jako import strona → feature workflow. Reguła z docs/STRUCTURE.md:365 ('Shared across ≥2 features → src/components/') mówi, że to prymityw współdzielony; edytor nie powinien zależeć od feature workflow dla ramki.",
      before: [ { path: 'src/features/workflow/components/frame-panel.tsx', lines: 75, note: 'FramePanel, OVERLAY_FRAME_COLS' } ],
      after: [ { path: 'src/components/frame-panel.tsx', lines: 75, note: "FramePanel({ filePath: string; aside?: string; width: number; height: number; children: ReactNode }), OVERLAY_FRAME_COLS" } ],
      moves: [ 'frame-panel.tsx + frame-panel.test.tsx → src/components/' ],
      tests: 'frame-panel.test.tsx przechodzi razem z plikiem.',
      importers: 2,
      references: [ 'docs/STRUCTURE.md:611', 'docs/STRUCTURE.md:614', 'docs/STRUCTURE.md:616', 'docs/ARCHITECTURE.md:757' ],
      steps: [ '1. Przenieś plik i test.', '2. Zmień 2 importy.', '3. Uaktualnij 4 wzmianki w docs.' ],
      risks: 'Niskie. Po ff47a03 FramePanel czyta configStore.get().projectDir; components może importować stores (rank 3 < 4), więc przeniesienie nie łamie warstw, ale lepiej podać projectDir propsem. Pokrywa się z RF_UI_?? (jeśli ui proponuje to samo jako przeniesienie).'
    },
    {
      id: 'RF_REACT_15',
      kind: 'extract-shared',
      priority: 3,
      effort: 'S',
      risk: 'low',
      title: 'Jedno mapowanie ScrollKeyAction → pozycja w core/keybindings/scroll.ts',
      why: "Trzy kopie tego samego switcha line-up/line-down/page-up/page-down/top/bottom: help.tsx:54-76 (cursorForScrollAction), components/scrollable-document.tsx:127-148 (offsetForScrollAction) i workflow/keyboard.ts:66-86 (reviewScrollOffsetForAction). Różnią się tylko tym, czy przycinają wynik. resolveScrollKey już jest w core/keybindings/scroll.ts.",
      before: [ { path: 'src/core/keybindings/scroll.ts', lines: 67, note: 'ScrollKeyAction, resolveScrollKey' } ],
      after: [ { path: 'src/core/keybindings/scroll.ts', lines: 90, note: 'stepForScrollAction(input: { action: ScrollKeyAction; position: number; page: number; last: number }): number — zawsze przycięte do [0, last]' } ],
      moves: [ 'cursorForScrollAction (help.tsx:54-76), offsetForScrollAction (scrollable-document.tsx:127-148), reviewScrollOffsetForAction (keyboard.ts:66-86) → stepForScrollAction' ],
      tests: 'scroll.test.ts: macierz akcji. Testy help, scrollable-document i keyboard zostają.',
      importers: 5,
      references: [],
      steps: [ '1. Dodaj stepForScrollAction z testem.', '2. Zastąp trzy kopie.' ],
      risks: "scrollable-document.tsx:146 zwraca lineCount dla 'bottom' i przycina później — sprawdzić, że przycięcie daje ten sam offset. Pokrywa się z RF_UI_?? (duplikaty, jeśli istnieje)."
    },
    {
      id: 'RF_REACT_16',
      kind: 'split',
      priority: 2,
      effort: 'M',
      risk: 'low',
      title: 'LocalConnectionForm: czysty model połączenia, hook formularza i wiersz pola',
      why: "features/runners/local-connection-form.tsx ma 545 linii. Linie 44-286 to czysty model (localConnectionProvider, localConnectionModelRows, contextOf, defaultAddress, normalizeAddress, tokenReference, tokenError, runtimeOf, connectionStatus), 287-344 to dwa prezentacyjne komponenty (DimLine, FieldRow), a LocalConnectionForm (345-545) trzyma 4 useState, ref generacji sondy, resolveDraft, runCheck, activate i useInput w jednym ciele.",
      before: [ { path: 'src/features/runners/local-connection-form.tsx', lines: 545, note: 'model + DimLine + FieldRow + LocalConnectionForm' } ],
      after: [
        { path: 'src/features/runners/local-connection/model.ts', lines: 240, note: 'typy LocalConnection* i funkcje 44-286 — czyste' },
        { path: 'src/features/runners/local-connection/field-row.tsx', lines: 60, note: 'DimLine, FieldRow' },
        { path: 'src/features/runners/local-connection/use-form.ts', lines: 100, note: 'useLocalConnectionForm: apiBase, token, probe, index, resolveDraft, runCheck, activate, useInput' },
        { path: 'src/features/runners/local-connection/form.tsx', lines: 100, note: 'LocalConnectionForm — render' }
      ],
      moves: [ 'linie 44-286 → model.ts', 'DimLine, FieldRow → field-row.tsx', 'stan i handlery 361-455 → use-form.ts' ],
      tests: 'local-connection-form.test.tsx dzieli się na model.test.ts (normalizeAddress, tokenError, connectionStatus bez Ink) i form.test.tsx (zachowanie).',
      importers: 3,
      references: [],
      steps: [ '1. model.ts + testy.', '2. field-row.tsx.', '3. use-form.ts i form.tsx.', '4. Zmień 3 importy (runners.tsx, picker-view.tsx, use-picker-actions.ts).' ],
      risks: 'Niskie. Bramka 31 obejmuje src/features/runners. Nazwa folderu: pokrywa się z RF_UI_?? dla prefiksów w runners (jeśli istnieje) — ustalić jedną nazwę.'
    },
    {
      id: 'RF_REACT_17',
      kind: 'split',
      priority: 2,
      effort: 'M',
      risk: 'low',
      title: 'TwoColumnPicker i PickerView: podpowiedź, karta terminala i podgląd jako czyste moduły',
      why: "two-column-picker/picker.tsx (506 linii) trzyma czyste getHint z ESCAPE_HINTS (95-167), bylineLines (69-86), wrapValueLine i komponent TerminalPaneCard (168-230), buildRightDisplay (231-267) obok samego TwoColumnPicker (268-506). picker-view.tsx (472) trzyma czyste staleModelCopy, localConnectionPaneLines, postureLine (70-114), komponent ModelGuidance (115-142) oraz dwa duże domknięcia w renderze: terminalPaneFor (199-235) i resolvePreview (267-378, około 110 linii, z zagnieżdżonymi remedyFor, toolsByline, modelsByline).",
      before: [ { path: 'src/features/runners/two-column-picker/picker.tsx', lines: 506, note: 'hint, karta terminala, right display, picker' }, { path: 'src/features/runners/picker-view.tsx', lines: 472, note: 'kopia, ModelGuidance, terminalPaneFor, resolvePreview, PickerView' } ],
      after: [
        { path: 'src/features/runners/two-column-picker/hint.ts', lines: 80, note: 'PickerHintKind, ESCAPE_HINTS, getHint, bylineLines' },
        { path: 'src/features/runners/two-column-picker/terminal-pane-card.tsx', lines: 65, note: 'wrapValueLine, TerminalPaneCard' },
        { path: 'src/features/runners/two-column-picker/right-display.ts', lines: 40, note: 'RightDisplaySlot, buildRightDisplay' },
        { path: 'src/features/runners/two-column-picker/picker.tsx', lines: 260, note: 'TwoColumnPicker' },
        { path: 'src/features/runners/picker-preview.ts', lines: 160, note: 'pickerPreviewText(ctx, input), terminalPaneFor, staleModelCopy, localConnectionPaneLines, postureLine — czyste' },
        { path: 'src/features/runners/model-guidance.tsx', lines: 35, note: 'ModelGuidance' },
        { path: 'src/features/runners/picker-view.tsx', lines: 230, note: 'PickerView — konfiguracja TwoColumnPicker' }
      ],
      moves: [ 'getHint, ESCAPE_HINTS, bylineLines → hint.ts', 'TerminalPaneCard, wrapValueLine → terminal-pane-card.tsx', 'buildRightDisplay → right-display.ts', 'resolvePreview, terminalPaneFor + funkcje kopii → picker-preview.ts', 'ModelGuidance → model-guidance.tsx' ],
      tests: 'picker.*.test.tsx (5 plików) i picker-view.*.test.tsx (4 pliki) zostają. Nowe: hint.test.ts, right-display.test.ts, picker-preview.test.ts (podgląd bez renderu Ink).',
      importers: 2,
      references: [ 'docs/HOOKS.md:23', 'docs/STRUCTURE.md:437', 'docs/ARCHITECTURE.md:746' ],
      steps: [ '1. Czyste moduły z testami.', '2. Komponenty.', '3. tui-shots overlay-*-picker*.' ],
      risks: 'Reguła jednego ToolModelPicker (CLAUDE.md) zostaje — to podział wnętrza, nie nowy picker. Pokrywa się z RF_UI_?? dla runners (jeśli istnieje).'
    },
    {
      id: 'RF_REACT_18',
      kind: 'split',
      priority: 2,
      effort: 'S',
      risk: 'low',
      title: 'Sidebar: czysty deriveSidebarView i podkomponenty TaskRow, SidebarWaiting',
      why: "workflow/components/sidebar.tsx ma 436 linii, 3 komponenty (SidebarWaiting 161-212, TaskRow 213-245, Sidebar 292-436) i czyste helpery (statusGlyph, rowSpec 95-159, anchorIndex, overflowLabel, combinedOverflowLabel, taskHasStatusTail 246-277, packPieces 278-291 z dee6b6c). Ciało Sidebar 293-370 to około 80 linii czystego okna listy i wierszy załogi przed pierwszym JSX; od 016daca wiersz załogi bierze najpierw seat z useRunningSeats (deriveRunningSeats), potem seat zapisany.",
      before: [ { path: 'src/features/workflow/components/sidebar.tsx', lines: 436, note: 'SidebarWaiting, TaskRow, Sidebar + helpery' } ],
      after: [
        { path: 'src/features/workflow/layout/sidebar-view.ts', lines: 120, note: 'deriveSidebarView({ view, seats, recordedCrew, displayNames, width, height }) + anchorIndex, overflowLabel, combinedOverflowLabel, taskHasStatusTail — obok getSidebar* w layout/rect.ts' },
        { path: 'src/features/workflow/components/sidebar/task-row.tsx', lines: 100, note: 'TaskRow, rowSpec, statusGlyph, TASK_STATUS_GLYPH_NAME' },
        { path: 'src/features/workflow/components/sidebar/waiting.tsx', lines: 55, note: 'SidebarWaiting' },
        { path: 'src/features/workflow/components/sidebar/panel.tsx', lines: 120, note: 'Sidebar — render' }
      ],
      moves: [ 'linie 293-370 → deriveSidebarView', 'TaskRow + rowSpec → sidebar/task-row.tsx', 'SidebarWaiting → sidebar/waiting.tsx' ],
      tests: 'sidebar.test.tsx (1157 linii): przypadki okna i etykiet przepełnienia → layout/sidebar-view.test.ts bez Ink; reszta zostaje przy panel.tsx.',
      importers: 1,
      references: [ 'docs/design/tui-concepts/README.md:34' ],
      steps: [ '1. deriveSidebarView + test.', '2. Podkomponenty.', '3. Zmień import w body.tsx.' ],
      risks: 'Niskie. tui-shots workflow-* przy szerokości ≥ 120 kolumn.'
    },
    {
      id: 'RF_REACT_19',
      kind: 'split',
      priority: 3,
      effort: 'S',
      risk: 'low',
      title: 'StartPreparationPanel: model linii panelu poza komponentem, hardSplit z utils',
      why: "start-preparation/panel.tsx ma 372 linie, z czego 53-282 (230 linii) to czysty model: checksOf, hardSplit, wrapText, paragraph, blank, checkLines, spaced, detailLines, section, panelModel, panelLines, fitHint. Komponent to 283-364. hardSplit (66-83) dzieli słowo po grafemach jak utils/wrap.ts wrapHard i utils/display-text.ts wrapTerminalGraphemes.",
      before: [ { path: 'src/features/start-preparation/panel.tsx', lines: 372, note: 'model linii + komponent' } ],
      after: [ { path: 'src/features/start-preparation/panel-lines.ts', lines: 220, note: 'PanelLine, panelModel, panelLines, fitHint, wrapText — czyste; hardSplit zastąpiony wrapTerminalGraphemes' }, { path: 'src/features/start-preparation/panel.tsx', lines: 110, note: 'StartPreparationPanel + toneColor' } ],
      moves: [ 'linie 53-282 → panel-lines.ts', 'hardSplit → wrapTerminalGraphemes (utils/display-text.ts:130)' ],
      tests: 'panel.test.tsx (610 linii): przypadki zawijania i sekcji → panel-lines.test.ts bez Ink.',
      importers: 3,
      references: [],
      steps: [ '1. panel-lines.ts + test.', '2. Sprawdź równoważność hardSplit i wrapTerminalGraphemes na znakach szerokich.', '3. Komponent importuje model.' ],
      risks: 'Bramka 46 obejmuje src/features/start-preparation w całości. Zamiana hardSplit tylko przy identycznym wyniku.'
    },
    {
      id: 'RF_REACT_20',
      kind: 'split',
      priority: 3,
      effort: 'S',
      risk: 'low',
      title: 'TaskSummary: czyste fitDetailRun osobno; komponent bliżej jedynego konsumenta',
      why: "components/task-summary.tsx ma 424 linie: 27-204 to czysty algorytm dopasowania szczegółów (fitDetailRun, partitionSettledTail, isSettledTail, isRetrySegment), 275-373 to komponent, 374-421 detailRun. Wszyscy 4 konsumenci produkcyjni są w features/workflow (closed/copy.ts, closed/rows/briefs.tsx, conversation-flow/stage-summary.ts, conversation-rows/settled-row-block.tsx) — według docs/LAYERS.md (demotion przy 1 konsumencie) komponent nie jest współdzielony.",
      before: [ { path: 'src/components/task-summary.tsx', lines: 424, note: 'fitDetailRun + TaskSummary' } ],
      after: [ { path: 'src/features/workflow/components/task-summary/detail-run.ts', lines: 200, note: 'fitDetailRun, detailRun i helpery — czyste' }, { path: 'src/features/workflow/components/task-summary/view.tsx', lines: 150, note: 'TaskSummary, markerSpec, settledMarker' } ],
      moves: [ 'linie 27-204, 374-424 → detail-run.ts', 'linie 205-373 → view.tsx', 'plik przechodzi z src/components do features/workflow' ],
      tests: 'Testy task-summary (3 pliki) dzielą się: fitDetailRun → detail-run.test.ts bez Ink, render → view.test.tsx.',
      importers: 4,
      references: [ 'docs/STRUCTURE.md:434' ],
      steps: [ '1. Wyciągnij detail-run.ts.', '2. Przenieś komponent do features/workflow.', '3. Zmień 4 importy i docs/STRUCTURE.md:434.' ],
      risks: 'Pokrywa się z RF_UI_?? dla demotion src/components (jeśli istnieje); ta propozycja dodaje podział czysty/komponent.'
    },
    {
      id: 'RF_REACT_21',
      kind: 'split',
      priority: 3,
      effort: 'M',
      risk: 'medium',
      title: 'ConfirmApprovalPrompt: czysty reduktor klawiszy zamiast 60-liniowego useInput',
      why: "approval-prompt/confirm.tsx (274 linie) ma 4 useState i 3 lustrzane refy (67-73) oraz jeden handler useInput (104-165, 62 linie) z dwoma krokami (choose/reason), nawigacją, literami r/x/n/y i regułą nieodwracalnej akcji. Logika decyzji jest testowalna dziś tylko przez render Ink.",
      before: [ { path: 'src/features/workflow/components/approval-prompt/confirm.tsx', lines: 274, note: 'stan + handler klawiszy + render' } ],
      after: [
        { path: 'src/features/workflow/prompt-rows/confirm-keys.ts', lines: 90, note: "confirmKeyStep(state: ConfirmKeyState, input: string, key: Key, ctx: { options; irreversible }): { state: ConfirmKeyState; effect: 'none' | 'deny' | { confirm: string } } — czyste" },
        { path: 'src/features/workflow/components/approval-prompt/confirm.tsx', lines: 180, note: 'useKeyState(ConfirmKeyState) + useInput → confirmKeyStep → efekt' }
      ],
      moves: [ 'handler 104-165 + takeRow 91-102 → confirm-keys.ts', '4 useState + 3 refy → jeden useKeyState (RF_REACT_03)' ],
      tests: 'confirm-keys.test.ts: macierz klawisz × krok × nieodwracalność bez Ink.',
      importers: 1,
      references: [],
      steps: [ '1. Po RF_REACT_03.', '2. Zdefiniuj ConfirmKeyState i confirmKeyStep z testem.', '3. Komponent woła reduktor.' ],
      risks: 'To bramka bezpieczeństwa zapisów chronionych; każda gałąź musi mieć test przed zmianą. graceUntil zostaje w komponencie.'
    },
    {
      id: 'RF_REACT_22',
      kind: 'move',
      priority: 3,
      effort: 'S',
      risk: 'low',
      title: 'Strona edytora: zapis i przekazanie do edytora zewnętrznego jako hook features/editor',
      why: "app/overlays/editor.tsx (115 linii) trzyma handlery onSave (52-75) i onOpenExternal (81-92), które powtarzają writeSpecFile + basename(dirname(filePath)) i sprawdzenie ownerToken, oraz saveRefusal (21-24). vitest.config.ts:41 wyłącza ten plik z pokrycia, więc logika zapisu nie liczy się do progów.",
      before: [ { path: 'src/app/overlays/editor.tsx', lines: 115, note: 'efekty layoutu, onSave, onCancel, onOpenExternal, render' } ],
      after: [ { path: 'src/features/editor/use-plan-editor-session.ts', lines: 65, note: 'usePlanEditorSession({ projectDir }): { refusal; onSave; onCancel; onOpenExternal } + wspólne writeOwnedPlan(state, projectDir)' }, { path: 'src/features/editor/plan-save.ts', lines: 22, note: '+ saveRefusal' }, { path: 'src/app/overlays/editor.tsx', lines: 60, note: 'FramePanel + EditorBufferView + stopka' } ],
      moves: [ 'onSave, onOpenExternal, onCancel → use-plan-editor-session.ts', 'saveRefusal → plan-save.ts' ],
      tests: 'editor.test.ts (296 linii) zostaje; nowy use-plan-editor-session test bez renderu ramki. Kod wchodzi w pokrycie (features/editor nie jest wyłączony).',
      importers: 1,
      references: [ 'vitest.config.ts:41', 'docs/INVARIANTS.md:41', 'docs/INVARIANTS.md:42', 'scripts/invariants/gates.ts:194', 'scripts/invariants/gates.ts:200', 'docs/STRUCTURE.md:604' ],
      steps: [ '1. Dodaj hook w features/editor.', '2. Strona woła hook.', '3. Bramki 24 i 25 już obejmują src/features/editor/ — nowy plik nie może importować node:fs ani child_process (writeSpecFile z core/paths-io.ts jest dozwolony jak dziś).' ],
      risks: 'Niskie. Bramki 24/25 zostają zielone, bo hook używa tych samych importów co strona.'
    },
    {
      id: 'RF_REACT_23',
      kind: 'split',
      priority: 3,
      effort: 'S',
      risk: 'low',
      title: 'Help i Skills: czyste budowanie wierszy i przełączanie wyboru poza stroną',
      why: "help.tsx (201) buduje HelpRow (93-133) i trzyma cursorForScrollAction (54-76, RF_REACT_15) w stronie. skills.tsx (229) ma dwa inline komponenty (ScanRoots 51-85, SkillRow 97-118) i logikę zbioru w handlerach (toggle 131-138, ctrl+a 173-185). Obie strony są 'rozpuszczone', więc nie mają features/x na wnętrze.",
      before: [ { path: 'src/app/overlays/help.tsx', lines: 201, note: 'HelpRow, budowa wierszy, kursor' }, { path: 'src/app/overlays/skills.tsx', lines: 229, note: 'ScanRoots, SkillRow, toggle, customKeys' } ],
      after: [
        { path: 'src/features/palette/help-rows.ts', lines: 50, note: 'buildHelpRows({ commandItems, shortcuts }): HelpRow[] — palette już ma buildCommandItems' },
        { path: 'src/core/skills/selection.ts', lines: 30, note: 'toggleSkill(set, id), toggleAllSkills(set, ids) — czyste' },
        { path: 'src/app/overlays/help.tsx', lines: 140, note: 'strona' },
        { path: 'src/app/overlays/skills.tsx', lines: 190, note: 'strona; ScanRoots i SkillRow zostają, dopóki właściciel nie zdecyduje o features/skills' }
      ],
      moves: [ 'helpRows (112-133) → features/palette/help-rows.ts', 'toggle i ctrl+a → core/skills/selection.ts' ],
      tests: 'help-rows.test.ts i selection.test.ts bez Ink.',
      importers: 1,
      references: [ 'docs/STRUCTURE.md:580', 'docs/STRUCTURE.md:582' ],
      steps: [ '1. Czyste moduły z testami.', '2. Strony importują je.' ],
      risks: "Reguła 'dissolved' (CLAUDE.md:155) zostawia ScanRoots i SkillRow w stronie. Paleta (palette.tsx:134-163) ma ręczną obsługę klawiszy zamiast useFilterableList, bo ranking MRU zmienia kolejność — useFilterableList musiałby dostać opcję rank; tego tu nie proponuję."
    }
  ],
  keep: [
    { path: 'src/components/pickers/list-viewport.tsx', lines: 236, reason: 'Jeden prymityw: okno slotów z scroll-window.ts i jego render. Podział rozdzieliłby slot od jego rysowania.' },
    { path: 'src/components/input/multiline-input.tsx', lines: 382, reason: 'Jeden prymityw wejścia; edycja tekstu i segmenty są już w text-editing.ts i segments.ts, zostaje obsługa klawiszy jednego pola.' },
    { path: 'src/components/list-row.tsx', lines: 334, reason: 'Jeden prymityw wiersza z algorytmem dopasowania całych słów (fitWholeWords), który służy tylko temu wierszowi; 21 importerów produkcyjnych, stabilne API.' },
    { path: 'src/components/scrollable-document.tsx', lines: 287, reason: 'Jeden prymityw: okno dokumentu i przewijanie. Tylko mapowanie akcji idzie do core (RF_REACT_15).' },
    { path: 'src/components/markdown.tsx', lines: 299, reason: 'Czysty renderer markdown na wspólnym rdzeniu utils/markdown; jedna odpowiedzialność.' },
    { path: 'src/features/workflow/components/rail.tsx', lines: 283, reason: 'Jedno pojęcie (rail etapów) w trzech formach B/C i pomiarze komórek; formy dzielą znaczniki i tony.' },
    { path: 'src/hooks/use-filterable-list.ts', lines: 398, reason: 'Jeden prymityw z reduktorem stanu listy; czysty reduktor jest już oddzielony od hooka w tym samym pliku.' },
    { path: 'src/app/router.tsx', lines: 157, reason: 'Dwa switche renderScreen i renderOverlay — sama kompozycja, bez logiki.' }
  ],
  conventions: [
    'Reguły komponentów React dla tego repo (rekomendacja):',
    'Strona (src/app/screens|overlays/x.tsx) to tylko wywołania hooków i JSX regionów: bez inline function X() komponentów, bez .get() w renderze, cel do 150 linii. Logika idzie do features/x/hooks/, czysta derywacja do features/x/*.ts, regiony do features/x/components/.',
    'Rozmiar: funkcja komponentu do około 120 linii, plik .tsx do około 250 linii; jeden eksportowany komponent na plik plus prywatne prezentacyjne pomocniki do około 40 linii każdy.',
    'Prezentacyjny vs kontener: komponent prezentacyjny dostaje wszystko przez props i nie importuje stores/ (przykład docelowy: InlineMenuPanel, SettingRowView, HomeHintRow); kontener czyta store selektorami i woła handlery. Nazwy: XView dla czystego wiersza lub widoku (już są CrewRowView, EditorBufferView, FallbackRowView), X dla kontenera (para StopMenu/StopSheet już istnieje).',
    'Typ propsów: interface XProps tuż nad komponentem w tym samym pliku; eksport tylko gdy inny moduł buduje propsy (ResultMenuProps). Wspólne kształty (layout, segmenty) w types.ts feature albo w core.',
    'Folder na komponent złożony: gdy komponent ma 2 lub więcej plików (widok, hook klawiszy, czysty layout), dostaje folder z nazwą pojęcia i plikami bez powtórzenia prefiksu: inline-menu/panel.tsx, inline-menu/use-keys.ts, inline-menu/layout.ts; testy obok (panel.test.tsx, layout.test.ts). Komponent jednoplikowy zostaje płaski: x.tsx + x.test.tsx. Bez index.ts.',
    'Derywacja: obliczenie dłuższe niż kilka linii albo ternary głębszy niż 2 poziomy idzie do nazwanej czystej funkcji derive*/ *-layout.ts / *-view.ts, testowanej w .test.ts bez Ink. Date.now() i klatka spinnera to parametry tej funkcji.',
    'Klawisze: handler useInput dłuższy niż około 20 linii idzie do hooka use-*-keys.ts albo do czystego reduktora (wzorzec features/workflow/keyboard.ts). Stan czytany przez klawisze z tego samego odczytu stdin używa useKeyState, nigdy ręcznego lustrzanego refa.',
    'Store w renderze: tylko store.use(selector) albo useStores z odczytanymi polami. Bez subskrypcji bez odczytu i bez .get() w renderze; .get() tylko w handlerach, efektach i kodzie nie-React. Powtarzane selektory są nazwane (select*, is*) w pliku store.',
    'Propsy: więcej niż około 12 propsów (WorkflowFooter 28, ComposerProps 28) to sygnał, że część stanu należy do hooka albo store; propsy jednego konsumenta w komponencie współdzielonym (homeHint w Composer) to zapach.',
    'Inline handlery w JSX: tylko jednolinijkowe; dłuższe jako nazwana stała w hooku.',
    'Testy: prezentacyjny komponent → ink-testing-library z samych propsów; czysta derywacja → .test.ts; kontener i strona → istniejące testy stron. Dzięki temu workflow.test.tsx (3010 linii), home.test.tsx (2152) i input-footer.test.tsx (1334) mogą się skurczyć.',
    'Prymityw współdzielony zostaje w feature, dopóki ma jednego konsumenta-feature (InlineMenuPanel w features/workflow); do src/components idzie przy drugim (FramePanel, RF_REACT_14).',
    'Zgodność z regułami repo: zero useMemo/useCallback/React.memo, bez forwardRef/useImperativeHandle, strony nie importują stron, feature nie importuje feature, jeden ToolModelPicker, composer w src/components/composer — wszystkie propozycje to zachowują.',
    'Odsyłacze do części ui: RF_UI_?? dla długości workflow.tsx, setup.tsx, composer.tsx, prefiksów picker-* w runners i demotion src/components (task-summary, markdown) — tu te same pliki są dzielone po odpowiedzialności komponentu.'
  ]
});
