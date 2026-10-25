window.ATLAS = window.ATLAS || [];
window.ATLAS.push({
  id: 'ui',
  order: 8,
  title: 'TUI: ekrany, klawisze, komendy i karty',
  tagline: 'Co widzisz, którym klawiszem to zmieniasz i jak odpowiedź z karty wraca do silnika.',
  summary: `**TUI to jedna aplikacja Ink.** \`App\` (\`src/app/root.tsx\`) montuje \`Router\`, globalne klawisze (\`useAppKeys\`), komendy (\`useRuntimeCommands\`) i mysz. \`Router\` wybiera jeden z trzech ekranów (\`home\`, \`workflow\`, \`setup\`) i co najwyżej jeden overlay. Overlay zasłania ekran, ale ekran zostaje zamontowany, więc szkic w composerze i run pod spodem przeżywają overlay.

**Przejścia między ekranami są zamknięte.** \`routerStore.navigate\` przepuszcza tylko: home → workflow / setup, workflow → workflow / home, setup → home / workflow. Każde inne przejście kończy się błędem na linii feedbacku.

**Ekran workflow jest domem runu** – live i w spoczynku. Trasa niesie \`run\` (RunRecord) i \`execution\`: \`local\` (ten proces prowadzi run) albo \`at-rest\` (run odczytany z dysku). Kontynuacja runu w spoczynku nie nawiguje: \`continueRunInPlace\` przełącza \`execution\` na \`local\` w miejscu.

**Zdarzenia silnika docierają do UI jedną drogą:** EventBus → \`tuiSink\` (\`addTuiEvent\`) → \`addEvent\` → store-y \`events\`, \`tasks\`, \`tokens\`, \`lifecycle\`, \`operations\`. Decyzje człowieka idą drugą drogą: silnik czeka na promise z callbacku (\`onApprovalNeeded\`, \`onPlannerReply\`, \`onTieredApproval\`, \`onReviewChecksApproval\`, \`onContinuationNeeded\`), a UI rozwiązuje go z karty.

**Karty nad composerem:** plan card, panel pytań plannera, karta potwierdzenia chronionego zapisu, karta \`Reviewer checks\` (Run all / Skip all), menu recovery (\`Needs you\` / \`Seat down\`), menu wyniku (Apply / Show diff / Discard) i stop-sheet. Każda trzyma klawisze, dopóki Tab albo wpisany \`/\` nie odda ich composerowi.

**Klawisze w skrócie:**
- \`esc\` na live runie: otwiera stop-sheet, drugi \`esc\` = Stop now, trzeci \`esc\` = do domu po sprzątaniu.
- \`ctrl+c\`: na live runie pierwszy = Stop now i uzbraja quit na 2 s; drugi w 2 s = wyjście po sprzątaniu.
- Podczas Apply tego procesu \`esc\`, pusty \`⏎\` i \`/home\` kolejkują powrót do domu, a \`ctrl+c\` i \`/quit\` kolejkują wyjście (\`departureStore\`). Apply nie da się przerwać.
- \`ctrl+k\` paleta, \`ctrl+/\` pomoc, \`ctrl+,\` Settings, \`ctrl+q\` quit, \`ctrl+s\` skille (tylko home), \`ctrl+r\` ostatnie sesje (home).

**23 komendy runtime** w pięciu kategoriach (navigate, crew, workflow, view, io). Dispatch: dokładna nazwa → usunięta nazwa dostaje wskazówkę → zły ekran → \`guard\` (powód blokuje komendę i ukrywa jej wiersz w palecie i pomocy) → handler.

**Fallback seat-a wybierasz tylko w jednym miejscu:** Settings › Fallback → ⏎ → \`ToolModelPicker\` w slocie \`fallback\`. Ten sam komponent obsługuje trzy role (planner, implementer, reviewer) i dwa sloty (seat, fallback).`,
  entry: [
    'src/app/root.tsx:60',
    'src/app/router.tsx:75',
    'src/app/keys.ts:151',
    'src/app/command-context.ts:455',
    'src/engine/orchestrator/run/init-sinks.ts:35'
  ],
  links: [
    { to: 'startup', label: 'CLI montuje App na setup / home / workflow (routerStore.init)' },
    { to: 'planning', label: 'plan card i pytania plannera (onApprovalNeeded, onPlannerReply)' },
    { to: 'build', label: 'kolejka wiadomości, /steer, pauza po briefie, karta chronionego zapisu' },
    { to: 'review', label: 'karta Reviewer checks: Run all / Skip all' },
    { to: 'recovery', label: 'menu Needs you / Seat down; switch-seat otwiera picker seat-a' },
    { to: 'lifecycle', label: 'stop / leave / quit, continueRun, Apply / Discard / End run, hydracja at rest' },
    { to: 'runners', label: 'picker zapisuje seat i fallback do .splitbrief/config.yaml' },
    { to: 'subsystems', label: 'EventBus → tuiSink → store-y workflow' }
  ],
  diagrams: [
    {
      id: 'ui-nav-map',
      title: 'Mapa ekranów: skąd i dokąd',
      caption: 'Trzy ekrany i dozwolone przejścia. Workflow ma dwa tryby: local (ten proces prowadzi run) i at-rest (run z dysku). Kontynuacja nie zmienia ekranu.',
      mermaid: `flowchart LR
  CLI["splitbrief start / init / continue"] --> UI_BOOT_ROUTE{"Od którego ekranu startuje App?"}
  UI_BOOT_ROUTE -->|"brak configu"| SETUP["setup: discovery → crew"]
  UI_BOOT_ROUTE -->|"start z feature lub bez"| HOME["home: composer + ostatnie sesje"]
  UI_BOOT_ROUTE -->|"continue / resume"| WFL["workflow · local"]
  HOME -->|"⏎ z opisem → prepareExecution"| WFL
  HOME -->|"wybór sesji: lista, ctrl+r, /sessions, paleta"| UI_SESSION_SELECT{"Czy wolno otworzyć run?"}
  UI_SESSION_SELECT -->|"tak"| WFR["workflow · at-rest"]
  UI_SESSION_SELECT -->|"Apply pisze albo local run na ekranie"| REFUSE["błąd wyboru, ekran zostaje"]
  SETUP -->|"Continue + czeka feature"| WFL
  SETUP -->|"Continue bez feature"| HOME
  SETUP -->|"esc na discovery / wyjście z crew"| EXIT["wyjście z aplikacji"]
  WFL -->|"pętla runu wraca: settleRun"| WFR
  WFR -->|"⏎ lub korekta: continueRunInPlace"| WFL
  WFL -->|"esc po stopie, /home"| HOME
  WFR -->|"esc, ⏎ na zamkniętym, /home"| HOME
  WFR -->|"wybór innej sesji"| WFR
  HOME --> UI_ROUTE_TRANSITION{"Przejście dozwolone?"}
  UI_ROUTE_TRANSITION -->|"nie, np. workflow → setup"| ERR["Cannot navigate from X to Y"]`
    },
    {
      id: 'ui-overlays',
      title: 'Overlaye i jak je otworzyć',
      caption: 'Overlay to stos: otwarcie nowego odkłada bieżący, esc zdejmuje jeden poziom. stop-sheet jest wyjątkiem: to menu nad composerem, router renderuje dla niego null.',
      mermaid: `flowchart TD
  ANY["dowolny ekran"] -->|"ctrl+k, /palette"| PAL["command-palette"]
  ANY -->|"ctrl+/, /help"| HELP["help"]
  ANY -->|"ctrl+, , /settings, /crew bez argumentu"| SET["settings: Crew, Fallback, Tuning, Workflow, Validation"]
  ANY -->|"/sessions"| SES["sessions"]
  ANY -->|"/skills bez argumentu"| SK["skills"]
  HOMEK["home"] -->|"ctrl+s (rescan skilli)"| SK
  SET -->|"⏎ na wierszu Crew"| SEATP["X-picker: slot seat"]
  SET -->|"⏎ na wierszu Fallback"| FBP["X-fallback-picker: slot fallback"]
  ANY -->|"/crew plan, build, review"| SEATP
  WFK["workflow"] -->|"/usage"| USE["usage-details"]
  WFK -->|"plan card: Edit, e, ctrl+e"| ED["editor (exclusive)"]
  WFK -->|"esc na live runie, /stop"| SS["stop-sheet (menu nad composerem)"]
  RC["menu recovery: switch-seat"] -->|"toolRowFocus oferowanego narzędzia"| SEATP
  SEATP --> UI_OVERLAY_STACK{"Overlay był otwarty pod spodem?"}
  FBP --> UI_OVERLAY_STACK
  UI_OVERLAY_STACK -->|"tak: esc wraca do niego"| SET
  UI_OVERLAY_STACK -->|"nie: esc zamyka do ekranu"| ANY`
    },
    {
      id: 'ui-command-dispatch',
      title: 'Dispatch komendy runtime i reguły odmowy',
      caption: 'Każda linia zaczynająca się od /name (bez drugiego /) idzie tą ścieżką, w każdym trybie composera. Komendy idą po kolei przez jeden łańcuch promise.',
      mermaid: `flowchart TD
  IN["linia z composera, wiersz palety albo custom action"] --> UI_CMD_IS_COMMAND{"Pierwsze słowo to /name bez drugiego /?"}
  UI_CMD_IS_COMMAND -->|"nie"| TXT["tekst dla seat-a: kolejka, odpowiedź albo korekta"]
  UI_CMD_IS_COMMAND -->|"tak"| CHAIN["runtimeChain: czeka na poprzednią komendę"]
  CHAIN --> UI_CMD_LOOKUP{"Dokładna nazwa w rejestrze?"}
  UI_CMD_LOOKUP -->|"nie"| UI_CMD_REMOVED{"Nazwa w REMOVED_COMMANDS?"}
  UI_CMD_REMOVED -->|"tak"| RM["'/x was removed: wskazówka'"]
  UI_CMD_REMOVED -->|"nie, /skill:id"| SKH["'Did you mean /skills id?'"]
  UI_CMD_REMOVED -->|"nie, fzf znalazł"| SUG["'Unknown command: /x. Did you mean /y?'"]
  UI_CMD_REMOVED -->|"nie, nic"| UNK["'Type /help for available commands.'"]
  UI_CMD_LOOKUP -->|"tak"| UI_CMD_SCREEN{"validScreens zawiera bieżący ekran?"}
  UI_CMD_SCREEN -->|"nie"| SCR["'/x is only available on the workflow screen.'"]
  UI_CMD_SCREEN -->|"tak"| UI_CMD_GUARD{"guard zwraca powód?"}
  UI_CMD_GUARD -->|"tak"| GRD["powód na linii feedbacku; wiersz znika z palety i pomocy"]
  UI_CMD_GUARD -->|"nie"| H["handler(args)"]
  H -->|"wyjątek"| HE["toErrorMessage na linii feedbacku"]
  H --> UI_CMD_CHAIN{"Komenda uruchomiła Apply?"}
  UI_CMD_CHAIN -->|"tak"| NEXT["następna komenda rusza od razu; wynik Apply przyjdzie później"]
  UI_CMD_CHAIN -->|"nie"| WAIT["następna komenda czeka na ten handler"]`
    },
    {
      id: 'ui-esc-ladder',
      title: 'Drabina esc na ekranie workflow',
      caption: 'Jeden esc otwiera stop-sheet, drugi zatrzymuje run, trzeci wraca do domu. Szybkie esc esc esc (jeden chunk) robi to samo naraz. Apply tego procesu zamienia każdy esc na powrót do domu po Apply.',
      mermaid: `flowchart TD
  E["esc"] --> UI_ESC_ACTIVE{"Handler ekranu aktywny?"}
  UI_ESC_ACTIVE -->|"nie: overlay, karta potwierdzenia, completion, przygotowanie"| OWN["esc należy do tego elementu"]
  OWN --> UI_SHEET_ESC{"To otwarty stop-sheet?"}
  UI_SHEET_ESC -->|"tak, run zatrzymany albo at-rest"| SH1["zamknij + requestLeaveSession"]
  UI_SHEET_ESC -->|"tak, run żyje"| SH2["zamknij + requestStopNow"]
  UI_SHEET_ESC -->|"nie"| SH3["overlay zamyka się sam albo globalnie"]
  UI_ESC_ACTIVE -->|"tak"| UI_ESC_FIRST{"Komentarz na plan card albo otwarty panel pytań?"}
  UI_ESC_FIRST -->|"komentarz"| C1["anuluj komentarz, klawisze wracają do wierszy"]
  UI_ESC_FIRST -->|"panel pytań, po 150 ms"| C2["zamknij panel; odpowiedź z composera"]
  UI_ESC_FIRST -->|"nic"| UI_ESC_LADDER{"Stan runu"}
  UI_ESC_LADDER -->|"at-rest, stop w toku lub parked, Apply tego procesu"| HOMEQ["requestLeaveSession: dom po stopie lub po Apply"]
  UI_ESC_LADDER -->|"running, interrupted, paused albo halt"| UI_ESC_DOUBLE{"Drugi esc w 25 ms?"}
  UI_ESC_DOUBLE -->|"nie"| OPEN["otwórz stop-sheet"]
  UI_ESC_DOUBLE -->|"tak"| STOPNOW["requestStopNow; kilka ESC w chunku = też dom"]
  UI_ESC_LADDER -->|"lifecycle cancelled"| HOMEQ
  UI_ESC_LADDER -->|"inaczej"| NOOP["nic"]
  OPEN --> UI_SHEET_ROWS{"Jakie wiersze pokazać?"}`
    },
    {
      id: 'ui-quit-departure',
      title: 'ctrl+c, quit i kolejka wyjścia',
      caption: 'Wyjście (home albo quit) zawsze idzie przez requestDeparture. Ono czeka na Apply albo na koniec stopu, potem zapisuje szkice i dopiero wtedy wychodzi.',
      mermaid: `flowchart TD
  CC["ctrl+c"] --> UI_CTRLC{"Drugie naciśnięcie w 2 s, stop w toku albo Apply tego procesu?"}
  UI_CTRLC -->|"tak"| RQ["requestQuit(exit)"]
  UI_CTRLC -->|"nie"| ARM["'Press ctrl+c again to quit' przez 2 s"]
  ARM --> LIVE{"Workflow local i nic się nie zatrzymuje?"}
  LIVE -->|"tak"| SN["zamknij stop-sheet + requestStopNow"]
  LIVE -->|"nie"| WAITK["tylko uzbrojenie"]
  Q2["/quit, ctrl+q"] --> RQ
  H2["esc w domu, Back to sessions, pusty ⏎ przy Apply"] --> RL["requestLeaveSession"]
  RQ --> UI_DEPART_QUEUE{"Kolejka już ma quit albo ten sam rodzaj?"}
  RL --> UI_DEPART_QUEUE
  UI_DEPART_QUEUE -->|"tak"| DROP["nic: powtórka"]
  UI_DEPART_QUEUE -->|"nie"| UI_DEPART_APPLY{"activeApply() tego procesu?"}
  UI_DEPART_APPLY -->|"tak"| UI_DEPART_AFTER_APPLY{"Po Apply: co z kolejki?"}
  UI_DEPART_AFTER_APPLY -->|"quit"| LEAVE["leave()"]
  UI_DEPART_AFTER_APPLY -->|"home i run closed as applied"| LEAVE
  UI_DEPART_AFTER_APPLY -->|"home, a Apply zatrzymał się"| STAY["zostań: widać halt"]
  UI_DEPART_APPLY -->|"nie"| STOPQ{"Jest co zatrzymać?"}
  STOPQ -->|"tak"| WSTOP["czekaj na parked lub ended; failed porzuca wyjście"]
  WSTOP --> LEAVE
  STOPQ -->|"nie"| LEAVE
  LEAVE --> UI_DRAFT_LEAVE{"flushSessionDrafts się udał?"}
  UI_DRAFT_LEAVE -->|"tak"| GO["nawigacja do home albo exit()"]
  UI_DRAFT_LEAVE -->|"nie, pierwszy raz na tym ekranie"| HOLD["zostań: 'Draft not saved · esc or quit again leaves without it'"]
  UI_DRAFT_LEAVE -->|"nie, drugi raz"| DISC["porzuć szkic i wyjdź"]`
    },
    {
      id: 'ui-prompts',
      title: 'Prośba silnika → karta w UI → odpowiedź',
      caption: 'Silnik czeka na promise. UI pokazuje kartę i rozwiązuje promise z wyborem. Karta zamknięta bez odpowiedzi (stop, zastąpienie) nie jest zgodą.',
      mermaid: `flowchart LR
  A1["onApprovalNeeded"] --> PC["plan card: Approve, Request changes, Edit plan.json, End run"]
  PC --> UI_PLAN_CARD_ENTER{"⏎ na pustym szkicu: który wiersz?"}
  UI_PLAN_CARD_ENTER -->|"Approve"| R1["approved: true"]
  UI_PLAN_CARD_ENTER -->|"Request changes"| R2["komentarz → revise"]
  UI_PLAN_CARD_ENTER -->|"Edit"| R3["editor → action edit"]
  UI_PLAN_CARD_ENTER -->|"End run"| R4["action end-run"]
  PC --> UI_PLAN_CARD_TEXT{"Wysłany tekst?"}
  UI_PLAN_CARD_TEXT -->|"słowo z listy"| R1
  UI_PLAN_CARD_TEXT -->|"inny tekst"| R2
  A2["onPlannerReply"] --> UI_QUESTION_ANSWER{"Pytania strukturalne?"}
  UI_QUESTION_ANSWER -->|"tak"| QP["QuestionPrompt: ↑↓, ⏎, Tab"]
  UI_QUESTION_ANSWER -->|"nie"| QC["odpowiedź w composerze; pusty ⏎ = domyślne"]
  A3["onTieredApproval"] --> CF["karta potwierdzenia zapisu"]
  CF --> UI_CONFIRM_KEYS{"Klawisz?"}
  UI_CONFIRM_KEYS -->|"y lub ⏎ na Confirm"| R5["confirm"]
  UI_CONFIRM_KEYS -->|"r"| R6["confirm z powodem"]
  UI_CONFIRM_KEYS -->|"x, n, esc"| R7["deny: user_denied"]
  A4["onReviewChecksApproval"] --> UI_CHECKS_CARD{"Run all czy Skip all?"}
  UI_CHECKS_CARD -->|"Run all"| R8["run"]
  UI_CHECKS_CARD -->|"Skip all"| R9["skip"]
  UI_CHECKS_CARD -->|"zastąpiona albo zamknięta"| R10["undefined: nie jest pass"]
  A5["pendingRecovery"] --> UI_RECOVERY_AUTO{"Halt ma switchSeat.auto?"}
  UI_RECOVERY_AUTO -->|"tak"| AUTO["zmiana seat-a bez panelu"]
  UI_RECOVERY_AUTO -->|"nie"| RM["menu recovery"]
  RM --> UI_RECOVERY_KEYS{"Litera, ⏎ czy Tab?"}
  A6["status ready-to-apply"] --> UI_RESULT_ROW{"Wiersz menu wyniku?"}`
    },
    {
      id: 'ui-workflow-states',
      title: 'Co pokazuje ekran workflow w każdym stanie runu',
      caption: 'Najpierw execution (local czy at-rest), potem status rekordu. Od tego zależy pasek etapów, blok postępu, byline i to, co robi composer oraz pusty ⏎.',
      mermaid: `flowchart TD
  R["trasa workflow"] --> UI_WF_EXEC{"execution.kind?"}
  UI_WF_EXEC -->|"local"| UI_BYLINE_LEAD{"Co prowadzi byline?"}
  UI_BYLINE_LEAD -->|"panel recovery czeka"| L1["Choose how to continue"]
  UI_BYLINE_LEAD -->|"stop w toku lub parked"| L2["Stopping T003 · ... albo Stopped at T003"]
  UI_BYLINE_LEAD -->|"pytanie lub karta"| L3["Waiting for your answer"]
  UI_BYLINE_LEAD -->|"cancelled"| L4["Stopped by you albo Build failed"]
  UI_BYLINE_LEAD -->|"cisza seat-a"| L5["No output for 1:05"]
  UI_BYLINE_LEAD -->|"praca trwa"| L6["spinner + czynność + zegar etapu"]
  UI_WF_EXEC -->|"local, Apply tego procesu"| AP["Applying to your checkout · zegar; tylko komendy"]
  UI_WF_EXEC -->|"at-rest"| UI_WF_STATUS{"record.status.kind?"}
  UI_WF_STATUS -->|"running"| UI_WF_RUNNING_WHO{"To Apply tego procesu?"}
  UI_WF_RUNNING_WHO -->|"tak"| AP
  UI_WF_RUNNING_WHO -->|"nie"| OTH["Running in another process; esc i ⏎ = dom od razu"]
  UI_WF_STATUS -->|"open"| UI_AT_REST_COMPOSER{"Stan czytelny i co przyjmuje composer?"}
  UI_AT_REST_COMPOSER -->|"nieczytelny"| UNR["Saved state unreadable · Start it again from home"]
  UI_AT_REST_COMPOSER -->|"czytelny"| UI_OPEN_BYLINE{"Na czym stoi run?"}
  UI_OPEN_BYLINE --> CONT["⏎ kontynuuje; tekst = korekta albo odpowiedź"]
  UI_WF_STATUS -->|"ready-to-apply"| RES["menu wyniku: Apply, Show diff, Discard"]
  UI_WF_STATUS -->|"closed"| CL["blok Closed na końcu transkryptu; bez sidebara; ⏎ = dom"]
  R --> UI_PROGRESS_ROWS{"Pokazać blok postępu?"}
  R --> UI_RAIL_AT_REST{"Jakie znaki na pasku etapów?"}`
    },
    {
      id: 'ui-fallback-picker',
      title: 'Settings › Fallback → picker w slocie fallback',
      caption: 'Fallback seat-a wybierasz tylko tutaj. Wiersze Crew otwierają picker seat-a, wiersze Fallback picker fallbacku. Zapis w trakcie runu działa od granicy briefu.',
      mermaid: `flowchart TD
  S["ctrl+, albo /settings"] --> ROWS["Crew: seat:plan, seat:build, seat:review; Fallback: fallback:plan, ..."]
  ROWS -->|"⏎ na Crew"| CREW["crewActivate → X-picker, fokus na osi effort"]
  ROWS -->|"⏎ na Fallback"| UI_FALLBACK_OPEN{"Co jest zapisane jako fallback?"}
  UI_FALLBACK_OPEN -->|"tool + model"| F1["picker na osi modelu"]
  UI_FALLBACK_OPEN -->|"tylko tool"| F2["picker na wierszu narzędzia"]
  UI_FALLBACK_OPEN -->|"nic"| F3["picker na wierszu None"]
  F1 --> UI_FALLBACK_COMMIT{"Co wybrano w pickerze?"}
  F2 --> UI_FALLBACK_COMMIT
  F3 --> UI_FALLBACK_COMMIT
  UI_FALLBACK_COMMIT -->|"None, nic nie było"| C0["zamknij bez zapisu"]
  UI_FALLBACK_COMMIT -->|"None, był fallback"| C1["usuń fallback: 'Seat down pauses and asks'"]
  UI_FALLBACK_COMMIT -->|"ten sam tool i model co seat"| C2["błąd: 'X runs ... now · choose another tool or model'"]
  UI_FALLBACK_COMMIT -->|"inny tool lub model"| C3["commitFallbackSelection → zapis config.yaml"]
  CREW --> SAVE["zapis seat-a"]
  C3 --> UI_SEAT_CHANGE_POINT{"Run tego procesu biegnie i tożsamość seat-a się zmieniła?"}
  SAVE --> UI_SEAT_CHANGE_POINT
  UI_SEAT_CHANGE_POINT -->|"tak"| B["'BUILD seat changes after T003'; run re-preparuje się na granicy briefu"]
  UI_SEAT_CHANGE_POINT -->|"nie"| OK["'Saved ... to .splitbrief/config.yaml'"]`
    },
    {
      id: 'ui-event-path',
      title: 'Zdarzenia silnika → store-y → ekran',
      caption: 'Jedyna droga zdarzeń do UI. Po anulowaniu przechodzą tylko zdarzenia, które domykają wywołania.',
      mermaid: `flowchart LR
  BUS["EventBus.publish(event)"] -->|"bus.subscribe(tuiSink)"| SINK["addTuiEvent: boundEngineEventForConsumer"]
  SINK --> UI_EVENT_DROP{"Jaki event i czy run anulowany?"}
  UI_EVENT_DROP -->|"cost_update"| TOK["tokensStore tylko"]
  UI_EVENT_DROP -->|"cancelled i event spoza listy"| DROP["odrzucony"]
  UI_EVENT_DROP -->|"inaczej"| FAN["eventsStore → tasksStore → tokensStore → lifecycleStore → operationsStore"]
  FAN --> VIEW["transkrypt, sidebar, pasek etapów, byline, blok postępu"]
  CB["callbacki silnika (promise)"] --> PROMPTS["approvalPromptStore, questionPromptStore, reviewChecksPromptStore, useInputMode, stopStore.park"]
  PROMPTS --> VIEW`
    }
  ],
  decisions: [
    {
      id: 'UI_BOOT_ROUTE',
      title: 'Ekran startowy aplikacji',
      question: 'Na którym ekranie CLI montuje App?',
      where: 'src/cli/commands/start/interactive.ts:41',
      inputs: ['needsSetup (brak configu)', 'feature z linii poleceń', 'komenda: start / init / continue'],
      branches: [
        { if: 'start i brak configu (needsSetup)', then: '`routerStore.init({ screen: setup, onComplete: feature ? workflow : home })`', next: 'UI_SETUP_FINALIZE' },
        { if: 'start z feature', then: 'App startuje na `home`; przygotowanie runu idzie w tle (`preparationStore.submit`, origin start), potem `navigate` do workflow local' },
        { if: 'start bez feature', then: 'App startuje na `home`' },
        { if: '`splitbrief init`', then: '`setup` z `onComplete: home` (src/cli/commands/init.ts:57)' },
        { if: '`continue` / `resume`', then: 'historia runu jest odtworzona przed montażem, potem `workflow` z `execution: local` (src/cli/commands/continue/resume.ts:141)' }
      ],
      default: 'home',
      notes: 'Szczegóły CLI → zobacz startup. Start z feature montuje Ink na home od razu, żeby komunikat discovery był widoczny.'
    },
    {
      id: 'UI_ROUTE_TRANSITION',
      title: 'Dozwolone przejścia między ekranami',
      question: 'Czy z bieżącego ekranu można przejść na docelowy?',
      where: 'src/stores/navigation/router.ts:72',
      inputs: ['bieżący ekran', 'ekran docelowy', 'tabela transitions (router.ts:42)'],
      branches: [
        { if: 'home → workflow lub setup', then: 'przejście, reset feedbacku, `supersede()`' },
        { if: 'workflow → workflow lub home', then: 'przejście' },
        { if: 'setup → home lub workflow', then: 'przejście' },
        { if: 'każde inne (np. workflow → setup, home → home)', then: 'brak przejścia; feedback `Cannot navigate from "X" to "Y"`' }
      ],
      default: 'Odmowa z błędem na linii feedbacku.',
      notes: '`updateRun` podmienia rekord runu na ekranie tylko dla tej samej sesji; nie nawiguje.'
    },
    {
      id: 'UI_SCREEN_RENDER',
      title: 'renderScreen: który ekran',
      question: 'Jaki komponent renderuje router dla `routerStore.screen`?',
      where: 'src/app/router.tsx:75',
      inputs: ['routerStore.screen'],
      branches: [
        { if: '`home`', then: '`HomeScreen` (src/app/screens/home.tsx)' },
        { if: '`workflow`', then: '`WorkflowScreen` (src/app/screens/workflow.tsx)' },
        { if: '`setup`', then: '`SetupScreen` (src/app/screens/setup.tsx)' }
      ],
      default: '`assertNever` – innego ekranu nie ma.',
      notes: '`Layout` (src/app/layout.tsx:24) ukrywa ekran (`display: none`), gdy overlay nie jest null albo panel przygotowania zajmuje stronę. Ekran zostaje zamontowany.'
    },
    {
      id: 'UI_OVERLAY_RENDER',
      title: 'renderOverlay: który overlay',
      question: 'Co renderuje router dla `overlayStore.active`?',
      where: 'src/app/router.tsx:116',
      inputs: ['overlayStore.active'],
      branches: [
        { if: '`none`', then: 'null – ekran widoczny' },
        { if: '`help` / `command-palette` / `skills` / `settings` / `sessions` / `usage-details` / `editor`', then: 'odpowiednia strona z src/app/overlays/' },
        { if: '`planner-picker` / `implementer-picker` / `reviewer-picker`', then: '`ToolModelPicker role=X slot=seat`' },
        { if: '`*-fallback-picker`', then: '`ToolModelPicker role=X slot=fallback`' },
        { if: '`stop-sheet`', then: 'null: menu rysuje sam ekran workflow nad composerem, transkrypt zostaje widoczny' }
      ],
      default: '`assertNever`.'
    },
    {
      id: 'UI_OVERLAY_STACK',
      title: 'Stos overlayów',
      question: 'Co się dzieje przy otwarciu i zamknięciu overlay-a?',
      where: 'src/stores/ui/overlay.ts:18',
      inputs: ['active', 'stack', 'focus'],
      branches: [
        { if: 'otwierasz ten sam overlay', then: 'zmienia się tylko fokus' },
        { if: 'otwierasz inny, gdy coś jest otwarte', then: 'bieżący trafia na stos, nowy jest aktywny' },
        { if: 'close() i stos niepusty', then: 'wraca poprzedni overlay z jego fokusem (np. Settings po pickerze)' },
        { if: 'close() i stos pusty', then: 'brak overlay-a' }
      ],
      default: 'Esc zdejmuje jeden poziom.',
      notes: 'Globalny esc stoi z boku, gdy overlay leży na niepustym stosie (poza `help`) albo gdy to picker seat-a – te obsługują esc same (najpierw czyszczą filtr). src/app/keys.ts:186.'
    },
    {
      id: 'UI_SHORTCUTS',
      title: 'Globalne skróty klawiszowe',
      question: 'Który skrót otwiera co?',
      where: 'src/app/keys.ts:374',
      inputs: ['klawisz', 'ekran', 'czy overlay otwarty', 'czy karta potwierdzenia czeka', 'czy przygotowanie sesji trwa'],
      branches: [
        { if: '`ctrl+k`', then: 'command-palette' },
        { if: '`ctrl+s` na home', then: 'rescan skilli (`refreshSkills`) i overlay skills' },
        { if: '`ctrl+/` (bajt 0x1f)', then: 'help' },
        { if: '`ctrl+,`', then: 'settings' },
        { if: '`ctrl+q`', then: '`requestQuit` (czeka na stop i zapis)' }
      ],
      default: 'Brak akcji.',
      notes: 'Te skróty działają tylko bez overlay-a, bez czekającej karty potwierdzenia i bez trwającego przygotowania sesji. `ctrl+c` ma osobny handler, aktywny zawsze. `ctrl+r` (home) i `ctrl+d`, `ctrl+a`, przewijanie (workflow) mają własne handlery.'
    },
    {
      id: 'UI_CMD_IS_COMMAND',
      title: 'Czy linia composera to komenda',
      question: 'Czy wysłany szkic idzie do dispatchera komend czy do seat-a?',
      where: 'src/components/composer/composer.tsx:547',
      inputs: ['pierwsze słowo szkicu', 'tryb composera', 'commandsOnly', 'pusty szkic'],
      branches: [
        { if: 'pierwsze słowo to `/name` bez drugiego `/` (isRuntimeCommandLine)', then: 'zapis w historii, czyszczenie szkicu, `onRuntimeCommand` – w każdym trybie, także przy pytaniu i menu recovery', next: 'UI_CMD_LOOKUP' },
        { if: 'tryb review albo question', then: '`send` – nawet pusty szkic idzie jako odpowiedź' },
        { if: 'tryb normal i pusty szkic', then: '`onEmptySubmit` (zobacz UI_EMPTY_ENTER)', next: 'UI_EMPTY_ENTER' },
        { if: 'commandsOnly', then: 'komunikat `Only /commands here · ⏎ on an empty line goes home`' },
        { if: 'inaczej', then: '`onSubmit` → handleInput ekranu', next: 'UI_NORMAL_INPUT' }
      ],
      default: 'Tekst trafia do handlera ekranu.',
      notes: '`/Users/me/notes.md` nie jest komendą (drugi `/`). `ctrl+⏎` z tekstem w trybie normal na live lub parked runie to `requestSteer`.'
    },
    {
      id: 'UI_CMD_LOOKUP',
      title: 'Wyszukanie komendy',
      question: 'Czy nazwa pasuje dokładnie do komendy z rejestru?',
      where: 'src/core/runtime/commands/dispatch.ts:26',
      inputs: ['pierwsze słowo (lowercase)', 'createRuntimeCommands(ctx)'],
      branches: [
        { if: 'dokładne dopasowanie nazwy', then: 'komenda znaleziona', next: 'UI_CMD_SCREEN' },
        { if: 'brak dopasowania', then: 'sprawdź listę usuniętych nazw', next: 'UI_CMD_REMOVED' }
      ],
      default: 'Brak aliasów i dopasowania po prefiksie.',
      notes: 'Rejestr (src/core/runtime/commands/registry.ts:9) skleja kategorie w kolejności navigate, crew, workflow, view, io. Razem 23 komendy: navigate `/help`, `/palette` (ukryta), `/skills`, `/sessions`, `/settings`, `/home`, `/quit`; crew `/crew`, `/refresh`; workflow `/stop`, `/resume`, `/steer`, `/end`, `/queue`, `/run`; view `/scroll`, `/activity`, `/sidebar`, `/tasks`, `/diff`, `/usage`; io `/copy`, `/image`.'
    },
    {
      id: 'UI_CMD_REMOVED',
      title: 'Usunięta albo nieznana nazwa',
      question: 'Jaki komunikat dostaje nieznana komenda?',
      where: 'src/core/runtime/commands/dispatch.ts:27',
      inputs: ['REMOVED_COMMANDS (types.ts:191)', 'fzf po nazwach'],
      branches: [
        { if: 'nazwa w REMOVED_COMMANDS (np. `/planner`, `/yolo`, `/mode`, `/accept-run`)', then: '`/x was removed: <wskazówka>`, np. `the PLAN seat is chosen with /crew plan`' },
        { if: 'nazwa zaczyna się od `/skill:`', then: '`Unknown command: /skill:x. Did you mean /skills x?`' },
        { if: 'fzf znalazł bliską komendę', then: '`Unknown command: /usge. Did you mean /usage?` – bez wykonania' },
        { if: 'nic', then: '`Unknown command: /x. Type /help for available commands.`' }
      ],
      default: 'Błąd na linii feedbacku.'
    },
    {
      id: 'UI_CMD_SCREEN',
      title: 'Komenda na złym ekranie',
      question: 'Czy komenda jest dostępna na tym ekranie?',
      where: 'src/core/runtime/commands/dispatch.ts:42',
      inputs: ['cmd.validScreens', 'ekran, z którego przyszła linia'],
      branches: [
        { if: 'ekran na liście', then: 'dalej do guard', next: 'UI_CMD_GUARD' },
        { if: 'ekranu brak', then: '`/x is only available on the workflow screen.`' }
      ],
      default: 'Odmowa.',
      notes: 'Tylko workflow: `/home`, `/stop`, `/resume`, `/steer`, `/end`, `/queue`, `/run`, `/scroll`, `/activity`, `/sidebar`, `/tasks`, `/diff`, `/usage`, `/copy`. `/image`: home i workflow. Reszta: wszystkie ekrany.'
    },
    {
      id: 'UI_CMD_GUARD',
      title: 'Guard komendy: kiedy i z jakim tekstem odmawia',
      question: 'Czy komenda może teraz działać?',
      where: 'src/core/runtime/commands/dispatch.ts:46',
      inputs: ['phase (lifecycleStore)', 'applying (activeApply tego procesu)', 'openRunAtRest', 'applyUnfinished', 'plannerSupportsImages'],
      branches: [
        { if: '`/stop` i Apply tego procesu pisze', then: '`Nothing to stop: Apply finishes on its own.` (workflow.ts:28)' },
        { if: '`/resume`, `/steer`, `/end`, `/run` i Apply pisze', then: '`Apply is still writing to your checkout.`' },
        { if: '`/end` na runie at rest z niedokończonym Apply', then: '`Apply did not finish. Restore or retry Apply first, then end the run.`' },
        { if: '`/resume` gdy faza nie jest live i run nie jest open at rest', then: '`No run to resume in this phase`' },
        { if: '`/steer` analogicznie', then: '`No run to steer in this phase`' },
        { if: '`/end` analogicznie', then: '`No run to end in this phase`' },
        { if: '`/image` gdy model PLAN nie widzi obrazów', then: '`PLAN seat cannot see images — pick a vision model with /crew plan`' },
        { if: 'brak powodu', then: 'handler wykonuje się', next: 'UI_CMD_CHAIN' }
      ],
      default: 'Brak guard-a = komenda działa.',
      notes: 'Ta sama funkcja guard ukrywa wiersz w palecie (src/features/palette/sources.ts:114), w pomocy i w liście `/`. Fazy live to tylko: researching, specifying, planning, implementing, escalating, final-review (src/core/phases.ts:42). Handler może odmówić później: `Nothing to resume.`, `Nothing to steer.`, `Usage: /steer <correction>`, `No active run to end.`, `Usage: /run <accept|reject>`, `Usage: /run reject confirm`.'
    },
    {
      id: 'UI_CMD_CHAIN',
      title: 'Kolejność komend i Apply',
      question: 'Czy następna komenda czeka na tę?',
      where: 'src/app/command-context.ts:499',
      inputs: ['activeApply() przed i po komendzie'],
      branches: [
        { if: 'komenda nie zmieniła activeApply', then: 'łańcuch czeka na jej promise' },
        { if: 'komenda uruchomiła Apply (np. `/run accept`)', then: 'łańcuch nie czeka; wynik Apply przyjdzie później, a `/home` lub `/quit` mogą się zakolejkować' }
      ],
      default: 'Komendy idą po kolei.'
    },
    {
      id: 'UI_PALETTE_ROWS',
      title: 'Co jest w palecie i w jakiej kolejności',
      question: 'Które wiersze pokazuje paleta i jak je układa?',
      where: 'src/features/palette/sources.ts:112',
      inputs: ['komendy (hidden, validScreens, guard)', 'skille', 'briefy (tylko implementing, validating-task, escalating)', '10 ostatnich sesji', '`palette.customActions`', 'MRU', 'zapytanie'],
      branches: [
        { if: 'komenda ukryta, na złym ekranie albo guard odmawia', then: 'brak wiersza' },
        { if: 'komenda z argumentem', then: 'wiersz wpisuje `/name ` do composera (prefill)' },
        { if: 'komenda bez argumentu', then: 'wiersz uruchamia komendę od razu' },
        { if: 'puste zapytanie', then: 'kolejność kategorii: navigate, crew, workflow, view, io, potem reszta (results.ts:204)' },
        { if: 'zapytanie', then: 'najpierw dokładna nazwa komendy, potem MRU, potem wynik fuzzy; sekcje zostają zwarte' }
      ],
      default: 'Wiersz sesji otwiera run at rest (handleSessionSelect); wiersz skilla przełącza przypięcie; wiersz briefu tylko pisze `Task T001: tytuł`.',
      notes: 'src/app/overlays/palette.tsx:123: wybór zapisuje MRU, zamyka paletę i wykonuje akcję.'
    },
    {
      id: 'UI_ESC_ACTIVE',
      title: 'Czy esc trafia do drabiny workflow',
      question: 'Kiedy handler esc ekranu workflow nasłuchuje?',
      where: 'src/app/keys.ts:326',
      inputs: ['ekran', 'overlay', 'overlay exclusive', 'karta potwierdzenia', 'completion', 'przygotowanie sesji'],
      branches: [
        { if: 'ekran workflow, brak overlay-a, brak karty potwierdzenia, brak listy podpowiedzi, brak przygotowania', then: 'esc idzie do drabiny', next: 'UI_ESC_FIRST' },
        { if: 'otwarty stop-sheet', then: 'osobny handler', next: 'UI_SHEET_ESC' },
        { if: 'karta potwierdzenia zapisu', then: 'esc = Deny (user_denied)', next: 'UI_CONFIRM_KEYS' },
        { if: 'inny overlay', then: 'overlay obsługuje esc sam albo globalne zamknięcie' }
      ],
      default: 'Esc nie dociera do drabiny.'
    },
    {
      id: 'UI_ESC_FIRST',
      title: 'Pierwszy esc dla komentarza i panelu pytań',
      question: 'Czy pierwszy esc należy do komentarza na plan card albo do panelu pytań?',
      where: 'src/app/keys.ts:305',
      inputs: ['reviewKeysStore.commenting', 'questionPromptStore.questions', 'openedAt + 150 ms (PROMPT_TYPEAHEAD_GRACE_MS)'],
      branches: [
        { if: 'trwa komentarz na plan card', then: 'czyści szkic i `endComment()`; klawisze wracają do wierszy karty' },
        { if: 'otwarty panel pytań, minęło 150 ms', then: '`questionPromptStore.close()`: runda czeka na odpowiedź z composera, pytania zostają jako blok w transkrypcie' },
        { if: 'esc wpisany przed upływem 150 ms', then: 'panel zostaje (esc nie był do niego)' },
        { if: 'nic z tego', then: 'drabina', next: 'UI_ESC_LADDER' }
      ],
      default: 'Drabina esc.',
      notes: 'Dwa esc w 25 ms: najpierw ten krok, potem krok drabiny (otwarcie stop-sheet).'
    },
    {
      id: 'UI_ESC_LADDER',
      title: 'Drabina esc: sheet, stop, dom',
      question: 'Co robi esc w zależności od stanu runu?',
      where: 'src/app/keys.ts:275',
      inputs: ['execution (local / at-rest)', 'stopStore.phase i intent', 'activeApply()', 'lifecycle.status i cancelled', 'recoveryNoticeStore.issue'],
      branches: [
        { if: 'run at rest, stop w toku lub parked, albo Apply tego procesu', then: '`requestLeaveSession` – dom (po stopie lub po Apply)', next: 'UI_DEPART_QUEUE' },
        { if: 'stopSheetReachable: status running, interrupted, paused albo otwarty halt; lifecycle nie anulowany', then: 'pojedynczy esc otwiera stop-sheet; drugi w 25 ms = Stop now', next: 'UI_ESC_DOUBLE' },
        { if: 'lifecycle cancelled', then: 'dom' },
        { if: 'inaczej', then: 'nic' }
      ],
      default: 'Brak akcji.',
      notes: 'Pauza z kontynuacji (status paused bez własnego parku) też otwiera sheet: run wraca do silnika. Esc nigdy nie wybiera End run.'
    },
    {
      id: 'UI_ESC_DOUBLE',
      title: 'Szybki drugi esc',
      question: 'Czy to drugi esc w oknie debounce (25 ms)?',
      where: 'src/app/keys.ts:142',
      inputs: ['bajty wejścia (same \\x1b)', 'isEscapeActionPending()'],
      branches: [
        { if: 'nie – pojedynczy esc', then: 'po 25 ms otwiera stop-sheet' },
        { if: 'tak – dwa esc w jednym chunku lub w 25 ms', then: '`requestStopNow()`' },
        { if: 'w chunku są co najmniej dwa esc', then: 'po Stop now także `requestLeaveSession` (esc esc esc = stop i dom)' }
      ],
      default: 'Otwarcie sheet-a.',
      notes: 'Każdy bajt inny niż esc kasuje oczekujący esc: to była głowa sekwencji (np. strzałka po wolnym łączu).'
    },
    {
      id: 'UI_SHEET_ESC',
      title: 'Esc przy otwartym stop-sheet',
      question: 'Co robi esc, gdy menu stopu jest otwarte?',
      where: 'src/app/keys.ts:345',
      inputs: ['stopStore (zatrzymany / w toku)', 'execution at-rest'],
      branches: [
        { if: 'run zatrzymany, stop w toku albo at rest', then: 'zamknij menu + `requestLeaveSession` (dom)' },
        { if: 'run żyje', then: 'zamknij menu + `requestStopNow` (Stop now)' }
      ],
      default: '—',
      notes: 'Tab tylko zamyka menu (src/features/workflow/stop/sheet.tsx:86). `/stop` je otwiera ponownie. Wpisany `/` zamyka menu i oddaje klawisze composerowi.'
    },
    {
      id: 'UI_SHEET_ROWS',
      title: 'Wiersze stop-sheet',
      question: 'Jakie akcje oferuje menu stopu w danym stanie?',
      where: 'src/features/workflow/stop/options.ts:150',
      inputs: ['stopStore.phase i intent', 'execution', 'record.status', 'activeApply()', 'running brief', 'recoveryNoticeStore.issue', 'isApplyUnfinishedAtRest'],
      branches: [
        { if: 'stop się nie udał (phase failed)', then: 'tylko `Retry stop` (retry cleanup and saving; do not start new work)' },
        { if: 'Apply tego procesu albo run at rest prowadzony przez inny proces', then: 'tylko `Back to sessions`' },
        { if: 'parked, ended albo at rest, run ready-to-apply', then: '`End run` (= Discard; changes saved in run.patch) + `Back to sessions`' },
        { if: 'parked albo at rest, run otwarty', then: '`Resume` + `End run` (bez End run, gdy Apply nie skończył się) + `Back to sessions`' },
        { if: 'parked albo at rest, run zamknięty', then: 'tylko `Back to sessions`' },
        { if: 'stop już w toku', then: 'tylko `Back after stop`' },
        { if: 'run live, otwarty halt', then: 'tylko `Stop now` i `End run` (jeśli halt go przyjmuje)' },
        { if: 'run live, brief biegnie', then: '`Stop now`, `Pause after this brief` (albo `Keep running`, gdy pauza czeka), `End run`' },
        { if: 'run live, brak briefu', then: '`Stop now`, `End run`' }
      ],
      default: 'Tytuł: `Stop options` albo `Session options` (gdy jest Back), stopka `Changes and draft stay.` albo `Draft stays.`',
      notes: 'Wybór wiersza: src/features/workflow/stop/sheet.tsx:31 – Resume → requestResume, Back → requestLeaveSession, Stop now / Retry stop → requestStopNow, Pause → requestBoundaryPause, Keep running → cancelBoundaryPause, End run → requestEndRun.'
    },
    {
      id: 'UI_CTRLC',
      title: 'ctrl+c: stop czy quit',
      question: 'Co robi to naciśnięcie ctrl+c?',
      where: 'src/app/keys.ts:258',
      inputs: ['quitUntil (2 s)', 'stopStore', 'activeApply()', 'ekran i execution', 'wklejanie w toku'],
      branches: [
        { if: 'trwa wklejanie (bracketed paste)', then: 'ignorowane' },
        { if: 'drugie naciśnięcie w 2 s, stop w toku albo Apply tego procesu', then: '`requestQuit` (kolejka wyjścia)', next: 'UI_DEPART_QUEUE' },
        { if: 'pierwsze naciśnięcie, workflow local, nic się nie zatrzymuje', then: 'pokaż `Press ctrl+c again to quit`, zamknij stop-sheet i `requestStopNow()`' },
        { if: 'pierwsze naciśnięcie gdzie indziej (home, setup, at rest, parked)', then: 'tylko `Press ctrl+c again to quit` na 2 s' }
      ],
      default: 'Każdy inny klawisz kasuje uzbrojenie.',
      notes: 'Ink może dostać `\\x03\\x03` w jednym chunku – każdy bajt liczy się jako osobne naciśnięcie.'
    },
    {
      id: 'UI_DEPART_QUEUE',
      title: 'Kolejka wyjścia (departureStore)',
      question: 'Czy nowe wyjście trafia do kolejki?',
      where: 'src/stores/workflow/departure.ts:14',
      inputs: ['zakolejkowane wyjście', 'nowe wyjście (home / quit)'],
      branches: [
        { if: 'w kolejce jest quit', then: 'nic się nie zmienia (quit wygrywa)' },
        { if: 'w kolejce jest ten sam rodzaj', then: 'nic (powtórka)' },
        { if: 'w kolejce jest home, przychodzi quit', then: 'quit zastępuje home' },
        { if: 'kolejka pusta', then: 'wpis', next: 'UI_DEPART_APPLY' }
      ],
      default: '—'
    },
    {
      id: 'UI_DEPART_APPLY',
      title: 'Wyjście czeka na Apply albo na stop',
      question: 'Na co czeka wyjście, zanim się wykona?',
      where: 'src/features/workflow/handlers.ts:371',
      inputs: ['activeApply()', 'stopStore.phase', 'handlers.stop'],
      branches: [
        { if: 'Apply tego procesu trwa', then: 'czekaj na koniec Apply; byline `Returns home when Apply finishes` / `Quits when Apply finishes`', next: 'UI_DEPART_AFTER_APPLY' },
        { if: 'run parked w granicy briefu i ma handler stop', then: 'zwolnij promise silnika (stop-now) i czekaj' },
        { if: 'jest co zatrzymać (requestStopNow zwraca true)', then: 'czekaj, aż stop dojdzie do parked albo ended' },
        { if: 'stop skończył się failed albo ekran przeszedł na inny run', then: 'porzuć wyjście' },
        { if: 'nic do zatrzymania', then: '`leave()` od razu', next: 'UI_DRAFT_LEAVE' }
      ],
      default: '`leave()`.'
    },
    {
      id: 'UI_DEPART_AFTER_APPLY',
      title: 'Wyjście po zakończeniu Apply',
      question: 'Czy zakolejkowane wyjście wykona się po Apply?',
      where: 'src/features/workflow/handlers.ts:353',
      inputs: ['rodzaj wyjścia', 'status rekordu po Apply', 'czy ekran nadal pokazuje ten run'],
      branches: [
        { if: 'quit', then: 'wyjście zawsze' },
        { if: 'home i run `closed` jako `applied`', then: 'dom' },
        { if: 'home, a Apply zatrzymał się (halt / restored)', then: 'zostajesz na runie: widać halt' },
        { if: 'ekran pokazuje już inny run', then: 'nic' }
      ],
      default: '—'
    },
    {
      id: 'UI_DRAFT_LEAVE',
      title: 'Szkic nie zapisał się przy wyjściu',
      question: 'Czy wolno wyjść, gdy zapis draft.json się nie udał?',
      where: 'src/features/workflow/handlers.ts:320',
      inputs: ['flushSessionDrafts()', 'leaveWasRefusedHere()'],
      branches: [
        { if: 'zapis się udał', then: 'wyjście (home albo exit)' },
        { if: 'zapis nie udał się, pierwsze wyjście z tego ekranu', then: 'zostajesz; transkrypt pokazuje przyczynę i plik, feedback `Draft not saved · esc or quit again leaves without it`' },
        { if: 'zapis nie udał się, drugie wyjście z tego samego ekranu', then: 'szkic porzucony, wyjście' }
      ],
      default: 'Wyjście.',
      notes: 'Pusty szkic nie tworzy pliku. Zapis szkicu idzie z opóźnieniem 300 ms (session-drafts.ts:125).'
    },
    {
      id: 'UI_STOP_NOW',
      title: 'requestStopNow',
      question: 'Czy jest co zatrzymać i jak?',
      where: 'src/features/workflow/handlers.ts:166',
      inputs: ['stopStore', 'handlers.stop', 'abortHandlers', 'handlers.cancel'],
      branches: [
        { if: 'run parked albo ended', then: 'false – nic do zatrzymania' },
        { if: 'stop już w toku (nie pauza)', then: 'true – bez nowego żądania' },
        { if: 'brak jakiegokolwiek handlera', then: 'false (byline nie ogłasza stopu)' },
        { if: 'jest handler stop', then: '`stopStore.request(stop-now)` (albo end-run), `handlers.stop()` = `controller.abort()`' },
        { if: 'tylko abort tury', then: '`abortTurn()`, inaczej przerwanie na granicy' }
      ],
      default: '—',
      notes: 'Byline stopu: `Stopping T003 · Waiting for processes to exit · 0:05`, potem `Stopped at T003 · Partial changes kept`. Szczegóły parku → zobacz lifecycle.'
    },
    {
      id: 'UI_END_RUN',
      title: 'requestEndRun',
      question: 'Jak End run zamyka run z tego ekranu?',
      where: 'src/features/workflow/handlers.ts:261',
      inputs: ['execution', 'record.status', 'hydrateResume', 'assertCanCloseRun'],
      branches: [
        { if: 'at rest i rekord `running`', then: 'false (`No active run to end.`)' },
        { if: 'at rest i rekord `closed`', then: 'tylko ponowny odczyt' },
        { if: 'at rest, stan czytelny', then: '`stopStore.request(end-run)`, `endRunAtRest`, `stopStore.end()`' },
        { if: 'live i stan nie pozwala zamknąć (np. niedokończony Apply)', then: 'błąd na feedbacku' },
        { if: 'live', then: '`stopStore.request(end-run)` + `requestCancel()` (abort z user_cancelled)' }
      ],
      default: '—',
      notes: 'Na runie ready-to-apply End run znaczy Discard i zachowuje run.patch → zobacz lifecycle.'
    },
    {
      id: 'UI_STEER',
      title: '/steer i ctrl+⏎',
      question: 'Jak korekta trafia do runu?',
      where: 'src/features/workflow/handlers.ts:206',
      inputs: ['tekst', 'stopStore', 'handlery runu'],
      branches: [
        { if: 'pusty tekst', then: 'false' },
        { if: 'run parked', then: 'wznów park z tekstem jako steer' },
        { if: 'stop w toku', then: '`Finish stopping before steering.`' },
        { if: 'brak handlerów (at rest)', then: '`requestResume(tekst)` – kontynuacja z korektą' },
        { if: 'live', then: 'Stop now, a tekst czeka na park i wtedy wznawia run' }
      ],
      default: '—'
    },
    {
      id: 'UI_NORMAL_INPUT',
      title: 'Tekst wysłany w trybie normal',
      question: 'Co dzieje się z tekstem wysłanym, gdy żadna karta nie czeka?',
      where: 'src/features/workflow/review-parser.ts:278',
      inputs: ['lifecycle.status', 'phase', 'kolejka (requestEnqueue)'],
      branches: [
        { if: 'interrupted, park jeszcze nie stoi', then: '`Interrupt pending — stopping at the next step boundary.`' },
        { if: 'faza live albo implementer', then: 'do kolejki seat-a aktywnego etapu; feedback np. `2 queued for BUILD on T003`' },
        { if: 'kolejka odrzuciła albo brak runu', then: 'szkic wraca do composera, błąd (`Cannot queue message: no active workflow.`)' },
        { if: 'faza bramki planu bez aktywnej karty', then: '`Review prompt is opening. Once active, use: ...`' }
      ],
      default: 'Brak akcji.',
      notes: 'Run parked albo anulowany idzie inną drogą: `continuation.handleResume`. Run at rest: `continueAtRest` (UI_CONTINUE_AT_REST). Zasady kolejki → zobacz build.'
    },
    {
      id: 'UI_PLAN_CARD_ENTER',
      title: 'Plan card: ⏎ na wierszu',
      question: 'Co robi pusty ⏎ na plan card?',
      where: 'src/app/screens/workflow.tsx:220',
      inputs: ['zaznaczony wiersz (↑↓)', 'czy trwa komentarz'],
      branches: [
        { if: 'trwa komentarz, a szkic pusty', then: 'nic – pusta zmiana nie ma czego wysłać' },
        { if: '`Approve plan and start the build`', then: '`approved: true` – build startuje' },
        { if: '`Request changes (type what to change)`', then: 'otwiera komentarz; następny tekst to korekta', next: 'UI_PLAN_CARD_TEXT' },
        { if: '`Edit plan.json`', then: 'editor w aplikacji; zapis (ctrl+s) sprawdza JSON, schemat i checkPlan, potem `action: edit`' },
        { if: '`End run (close this run)`', then: '`action: end-run`' }
      ],
      default: 'Wiersz nie ma liter: litera to tekst w composerze.',
      notes: 'Wiersze: src/features/workflow/prompt-rows/approval.ts. `ctrl+e` też otwiera edytor. Editor `ctrl+o` przechodzi do zewnętrznego edytora (VISUAL / EDITOR). Semantyka planu → zobacz planning.'
    },
    {
      id: 'UI_PLAN_CARD_TEXT',
      title: 'Plan card: wysłany tekst',
      question: 'Jak tekst wysłany przy plan card jest czytany?',
      where: 'src/features/workflow/review-parser.ts:318',
      inputs: ['reviewKeysStore.requested', 'parseReviewCommand', 'plik do edycji'],
      branches: [
        { if: 'po Request changes', then: 'cały szkic = korekta (`revise`), niezależnie od pierwszego słowa' },
        { if: '`approve`, `y`, `yes`, `ok`, `lgtm`, `continue`', then: 'zatwierdzenie' },
        { if: '`end-run`, `end`, `q`, `quit`, `reject`, `no`, `n`', then: 'End run' },
        { if: '`e`, `edit`, `edit-file`', then: 'editor' },
        { if: '`c`, `comment`', then: 'otwiera pusty komentarz' },
        { if: '`comment <tekst>`, `revise <tekst>`', then: 'korekta z tym tekstem' },
        { if: 'inny tekst i plan istnieje', then: 'korekta (`revise`)' },
        { if: 'inny tekst bez pliku', then: '`Unknown command. Use: approve, comment <text>, end-run, or edit`' }
      ],
      default: 'Korekta.'
    },
    {
      id: 'UI_QUESTION_ANSWER',
      title: 'Odpowiedź na pytania plannera',
      question: 'Jak UI odpowiada na `onPlannerReply`?',
      where: 'src/features/workflow/prompt-callbacks.ts:74',
      inputs: ['reply.questions', 'reply.seat', 'tekst odpowiedzi', 'paczka odpowiedzi'],
      branches: [
        { if: 'są pytania strukturalne', then: 'panel QuestionPrompt: ↑↓ wybór opcji, ⏎ odpowiada i przechodzi do następnego, Tab pisze własną odpowiedź; po ostatnim pytaniu wraca paczka Q/A' },
        { if: 'brak pytań', then: 'composer z podpowiedzią `Reply to the planner…` (albo `Reply to the reviewer…`)' },
        { if: 'pusty ⏎ bez pytań strukturalnych', then: 'pusta odpowiedź = planner bierze domyślne' },
        { if: 'tekst w composerze, gdy panel pytań ma fokus composera', then: '`New instruction — replaces these questions…`: tekst zastępuje rundę' },
        { if: 'esc', then: 'panel zamyka się; runda czeka na odpowiedź z composera', next: 'UI_ESC_FIRST' }
      ],
      default: 'Odpowiedź tekstowa.',
      notes: 'Pytanie bez opcji pokazuje swoją wartość domyślną jako jedyną opcję (questionOptions, src/stores/question-prompt/prompt.ts:30). Komenda wpisana w panelu idzie do dispatchera, nie jest odpowiedzią.'
    },
    {
      id: 'UI_CONFIRM_KEYS',
      title: 'Karta potwierdzenia chronionego zapisu',
      question: 'Jak odpowiedzieć na `onTieredApproval`?',
      where: 'src/features/workflow/components/approval-prompt/confirm.tsx:108',
      inputs: ['actionClass', 'klawisz', 'okno 150 ms po otwarciu'],
      branches: [
        { if: 'klawisz w ciągu 150 ms od otwarcia', then: 'ignorowany (ochrona przed pisaniem z wyprzedzeniem)' },
        { if: 'esc, `x` albo `n`', then: '`deny` z powodem `user_denied`' },
        { if: '`y` i klasa nie jest destructive', then: '`confirm` z `confirmed at the prompt (no reason given)`' },
        { if: '`y` i klasa destructive (zapis control-plane)', then: 'kursor wraca na Confirm i legenda mówi `⏎ confirms this write`' },
        { if: '`r` (poza runner_trust)', then: 'krok z pytaniem `Why are you making this change?`; ⏎ potwierdza z powodem' },
        { if: '⏎ na wierszu', then: 'akcja wiersza: Confirm / Confirm with a reason / Deny' }
      ],
      default: '—',
      notes: 'Ta sama karta pyta o zaufanie do runnera z configu projektu (`runner_trust`, tylko Confirm i Deny) na home i w setup. Zamknięcie przez stop daje `user_cancelled`, a zastąpienie `superseded` – oba to odmowa. Klasy → zobacz build.'
    },
    {
      id: 'UI_CHECKS_CARD',
      title: 'Karta Reviewer checks',
      question: 'Czy komendy wybrane przez reviewera mają się uruchomić?',
      where: 'src/features/workflow/review-checks/card.tsx:61',
      inputs: ['request.commands', 'wybrany wiersz'],
      branches: [
        { if: '`Run all`', then: '`run` – komendy biegną w workspace runu' },
        { if: '`Skip all`', then: '`skip` – żadna nie jest liczona jako pass' },
        { if: 'karta zastąpiona albo zamknięta przez stop', then: '`undefined` – silnik to nazywa, nigdy nie czyta jako Run' },
        { if: 'Tab', then: 'klawisze do composera (`Choose an action above, or tab to type a message…`)' }
      ],
      default: '—',
      notes: 'Karta pojawia się tylko przy `validation.approve_checks: ask`. Nie pokazuje się, gdy otwarty jest stop-sheet albo menu wyniku. → zobacz review.'
    },
    {
      id: 'UI_RECOVERY_AUTO',
      title: 'Halt z automatycznym fallbackiem',
      question: 'Czy halt pokazuje menu, czy UI od razu zmienia seat?',
      where: 'src/features/workflow/recovery-driver.ts:223',
      inputs: ['issue.switchSeat.auto'],
      branches: [
        { if: 'halt ma `switchSeat.auto` (zadeklarowany fallback, limit konta albo długi reset)', then: 'bez panelu i bez pickera: `switchSeat` z kandydatem wraca do pętli runu' },
        { if: 'brak auto', then: 'menu recovery w trybie pytania (`formatRecoveryPrompt`)', next: 'UI_RECOVERY_KEYS' }
      ],
      default: 'Menu recovery.',
      notes: 'Reguła „raz na run i seat” i `seatSwitches` → zobacz recovery.'
    },
    {
      id: 'UI_RECOVERY_KEYS',
      title: 'Klawisze menu recovery',
      question: 'Jak wybrać akcję w menu `Needs you` / `Seat down`?',
      where: 'src/features/workflow/components/recovery-menu.tsx:140',
      inputs: ['oferowane akcje', 'klawisz', 'szkic composera'],
      branches: [
        { if: 'litera akcji: r retry, u restore, w switch-seat, l retry later, v revise, k accept as is, c continue, s skip, a end run', then: 'wybór tej akcji (litera spoza oferty nic nie robi)' },
        { if: '↑↓ i ⏎', then: 'wybór zaznaczonego wiersza' },
        { if: 'Tab', then: 'klawisze do composera; ⏎ z tekstem = akcja korekty (np. revise) z tym tekstem' },
        { if: 'akcja `switch-seat`', then: 'picker seat-a otwarty na oferowanym narzędziu', next: 'UI_SWITCH_SEAT' },
        { if: 'tekst przy akcji, która słów nie czyta', then: '`Cannot send words with <akcja>. Clear them.`' },
        { if: 'esc', then: 'stop-sheet z `Stop now` i `End run`' }
      ],
      default: 'Menu zostaje, dopóki akcja się nie powiedzie.',
      notes: 'Akcja zablokowana daje błąd i menu pyta znowu (recovery-driver.ts:404).'
    },
    {
      id: 'UI_SWITCH_SEAT',
      title: 'switch-seat: picker zamiast listy narzędzi',
      question: 'Kiedy wybór w pickerze to zmiana seat-a?',
      where: 'src/features/workflow/recovery-driver.ts:152',
      inputs: ['oferowany kandydat', 'seat, na którym biegło wywołanie', 'config po zamknięciu pickera'],
      branches: [
        { if: 'picker zamknięty bez wyboru (esc)', then: 'anulowane: menu recovery pyta znowu' },
        { if: 'wybrany ten sam seat (tool, model, effort, variant) co przy haltcie', then: 'anulowane' },
        { if: 'inny seat zapisany', then: '`switchSeat` wraca do pętli runu, run re-preparuje się na nowym seat-cie' },
        { if: 'brak oferty', then: '`No other tool is offered for this seat.`' }
      ],
      default: '—'
    },
    {
      id: 'UI_RESULT_ROW',
      title: 'Menu wyniku: Apply / Show diff / Discard',
      question: 'Co robi wybrany wiersz menu wyniku?',
      where: 'src/features/workflow/result/menu.tsx:63',
      inputs: ['override (Accept as is)', 'confirming', 'liczba zmienionych plików'],
      branches: [
        { if: '`Apply` bez override', then: '`/run accept`', next: 'UI_RUN_ACCEPT' },
        { if: '`Apply as is` (override)', then: 'krok potwierdzenia: `Apply with N open findings?`, wiersze `Apply as is` i `Back`' },
        { if: '`Apply as is` w potwierdzeniu', then: '`/run accept confirm`' },
        { if: '`Show diff`', then: 'zapis run.patch i otwarcie w VISUAL / EDITOR albo PAGER (less); checkout-run: `No run workspace to diff.`; pusto: `No run changes to show.`' },
        { if: '`Discard`', then: '`/run reject confirm`', next: 'UI_RUN_REJECT' },
        { if: 'Tab', then: 'klawisze do composera; pusty ⏎ wraca do menu' }
      ],
      default: '—',
      notes: 'Menu jest tylko dla rekordu `ready-to-apply` i nie wtedy, gdy otwarty jest stop-sheet. Litery nie wybierają akcji.'
    },
    {
      id: 'UI_RUN_ACCEPT',
      title: '/run accept',
      question: 'Co robi `/run accept` na danym runie?',
      where: 'src/app/command-context.ts:148',
      inputs: ['hydration', 'workspace.kind', 'record.status', 'czy run at rest', 'confirm'],
      branches: [
        { if: 'stan nieczytelny', then: '`Cannot read this run: ...`' },
        { if: 'brak workspace (stary run)', then: 'akceptacja snapshotu: `Run accepted at snapshot <id>`' },
        { if: 'run zamknięty', then: '`Run already applied.` albo `Run is closed (<as>).`' },
        { if: 'run nie jest at rest albo running', then: '`Apply is unavailable while the run is active.`' },
        { if: 'nie checkout i nie ready-to-apply', then: '`Run is not ready to apply.`' },
        { if: 'workspace checkout', then: 'zamknięcie jako ended: `Run closed as it is; its changes are already in your checkout.`' },
        { if: 'Apply: halted / restored', then: '`Apply stopped; resolve it in the recovery menu.`' },
        { if: 'Apply: review (checkout zmienił te same pliki)', then: 'run wraca do checków i review; kontynuuj run' },
        { if: 'Apply: needs-confirmation', then: 'nic (menu pyta o Apply as is)' },
        { if: 'Apply: applied', then: '`Applied N files to your checkout.`' }
      ],
      default: '—',
      notes: 'Mechanika Apply → zobacz lifecycle.'
    },
    {
      id: 'UI_RUN_REJECT',
      title: '/run reject confirm',
      question: 'Co robi `/run reject confirm`?',
      where: 'src/app/command-context.ts:199',
      inputs: ['hydration', 'workspace.kind', 'record.status', 'canUndoApply'],
      branches: [
        { if: 'brak słowa confirm', then: '`Usage: /run reject confirm`' },
        { if: 'run zamknięty i nie da się cofnąć Apply', then: '`Run is closed (<as>).` albo `Apply already undone; the run is closed.`' },
        { if: 'run aktywny', then: '`Run rejection is unavailable while the run is active.`' },
        { if: 'run zamknięty jako applied, cofnięcie możliwe', then: 'undo Apply: `Apply undone: put back N replaced files, ...`' },
        { if: 'workspace checkout albo stary run', then: 'przywrócenie z run snapshotu; feedback wskazuje wiersz `Rejected` w transkrypcie' },
        { if: 'worktree / staged-copy przed Apply', then: 'Discard: `Run discarded; its changes are saved in run.patch in the session folder.`' }
      ],
      default: '—'
    },
    {
      id: 'UI_WF_EXEC',
      title: 'Ekran workflow: local czy at rest',
      question: 'Kto obsługuje wysłany tekst i co znaczy ekran?',
      where: 'src/features/workflow/hooks/workflow-screen/use-model.ts:223',
      inputs: ['route.execution.kind', 'stopStore.phase parked', 'lifecycle.cancelled', 'activeApply()'],
      branches: [
        { if: 'at-rest', then: 'tekst = `continueAtRest` (kontynuacja z korektą)', next: 'UI_CONTINUE_AT_REST' },
        { if: 'local i parked albo cancelled', then: '`continuation.handleResume`' },
        { if: 'local, run żyje', then: 'handler kart i kolejki (`createReviewInputHandler`)', next: 'UI_NORMAL_INPUT' },
        { if: 'Apply tego procesu', then: 'composer tylko na komendy; placeholder `/ for a command · ⏎ for home when Apply finishes…`' }
      ],
      default: '—',
      notes: 'Ekran at rest obserwuje state.json, lock, session.jsonl i summary (watchFile co 100 ms) i czyta rekord ponownie, gdy inny proces coś zmieni (use-model.ts:98).'
    },
    {
      id: 'UI_CONTINUE_AT_REST',
      title: 'Kontynuacja runu w spoczynku',
      question: 'Czy run at rest da się kontynuować z tego ekranu?',
      where: 'src/features/workflow/hooks/workflow-screen/use-model.ts:133',
      inputs: ['continueRun (decyzja silnika)', 'tekst korekty'],
      branches: [
        { if: 'continueRun pozwala', then: '`continueRunInPlace`: sprawdzenie narzędzi, potem `execution: local` w miejscu, bez nawigacji' },
        { if: 'odmowa: closed albo ready-to-apply', then: 'ponowny odczyt rekordu + błąd' },
        { if: 'odmowa: takes-no-words (halt nie czyta słów)', then: 'szkic wraca do composera + błąd' },
        { if: 'inna odmowa', then: 'błąd na feedbacku' }
      ],
      default: '—',
      notes: 'Reguły continueRun → zobacz lifecycle. Esc w czasie sprawdzania narzędzi anuluje próbę.'
    },
    {
      id: 'UI_SESSION_SELECT',
      title: 'Otwarcie runu z listy sesji',
      question: 'Czy wolno otworzyć wybrany run?',
      where: 'src/stores/navigation/session-select.ts:224',
      inputs: ['activeApply tego procesu', 'execution bieżącego ekranu'],
      branches: [
        { if: 'Apply tego procesu pisze', then: '`Apply is still writing to your checkout. Cannot open "<feature>".`' },
        { if: 'ekran pokazuje run local tego procesu', then: '`Stop the run on screen first. Cannot open "<feature>".`' },
        { if: 'inaczej', then: 'odczyt rekordu, odtworzenie historii, skille runu, `navigate` workflow at-rest' }
      ],
      default: '—',
      notes: 'Wolniejszy odczyt starszego wyboru nic nie maluje, jeśli w międzyczasie wybrano nowszy (`supersede`).'
    },
    {
      id: 'UI_AT_REST_COMPOSER',
      title: 'Composer runu w spoczynku',
      question: 'Co przyjmuje composer runu at rest?',
      where: 'src/features/workflow/at-rest.ts:149',
      inputs: ['record.status', 'hydration', 'Apply tego procesu', 'zakolejkowane wyjście'],
      branches: [
        { if: 'ready-to-apply', then: 'tylko komendy; `/ for a command · tab for the result menu…`' },
        { if: 'Apply tego procesu', then: 'tylko komendy; `... ⏎ for home when Apply finishes…` (albo `/ for a command…` po quit)' },
        { if: 'nie open albo stan nieczytelny', then: 'tylko komendy; `/ for a command · ⏎ for home…`' },
        { if: 'open, czeka na pytanie', then: '`Type your answer…`' },
        { if: 'open, halt nie czyta słów', then: '`/ for a command…`' },
        { if: 'open', then: '`Type a correction…`', next: 'UI_OPEN_BYLINE' }
      ],
      default: '—'
    },
    {
      id: 'UI_OPEN_BYLINE',
      title: 'Byline otwartego runu w spoczynku',
      question: 'Co mówi wiersz pod composerem dla otwartego runu?',
      where: 'src/features/workflow/closed/byline.ts:232',
      inputs: ['status.stop.on.kind', 'resumeAt'],
      branches: [
        { if: 'paused', then: '`Stopped at T003 · type a correction or ⏎ to continue`' },
        { if: 'gate', then: '`Waiting at the plan · ⏎ to reopen it` (albo `⏎ to continue`)' },
        { if: 'question', then: '`Waiting for your answer · type a reply or ⏎ to continue`' },
        { if: 'halt', then: '`Needs you` / `Seat down · <headline> · ⏎ to decide` (albo zapisana akcja)' },
        { if: 'failed', then: '`Stopped by an error · <message> · ⏎ to retry the step`' },
        { if: 'seat-wait', then: '`Waiting for <tool> · <czas resetu>` albo `⏎ to continue`' }
      ],
      default: '`Stopped at ... · ⏎ to continue`',
      notes: 'Zamknięty run: `bylineParts` – np. `Ended · Bring the changes back with git apply on the Patch file`, `Undo the Apply with /run reject confirm`. Ready: `Ready to apply · pick Apply, Show diff or Discard`. Inny proces: `Running in another process`.'
    },
    {
      id: 'UI_EMPTY_ENTER',
      title: 'Pusty ⏎ na ekranie workflow',
      question: 'Co robi ⏎ na pustym composerze?',
      where: 'src/features/workflow/hooks/workflow-screen/use-model.ts:257',
      inputs: ['atRestRecord', 'continuable', 'Apply tego procesu', 'parked', 'menu wyniku / karta checks'],
      branches: [
        { if: 'menu wyniku otwarte', then: 'fokus wraca do menu (workflow.tsx:539)' },
        { if: 'karta Reviewer checks otwarta', then: 'fokus wraca do karty' },
        { if: 'at rest i continuable', then: 'kontynuacja runu' },
        { if: 'at rest i nie continuable', then: 'dom (`requestLeaveSession`)' },
        { if: 'Apply tego procesu', then: 'zakolejkuj dom' },
        { if: 'parked', then: '`requestResume` (jak `/resume`)' },
        { if: 'live', then: 'nic' }
      ],
      default: 'Nic.'
    },
    {
      id: 'UI_BYLINE_LEAD',
      title: 'Kolejność głosu w byline live',
      question: 'Która informacja prowadzi wiersz pod composerem?',
      where: 'src/features/workflow/components/input-footer.tsx:228',
      inputs: ['recoveryNoticeStore', 'stopByline', 'pytanie / karta', 'lifecycle.status', 'stall', 'deriveLiveStatus'],
      branches: [
        { if: 'menu recovery czeka', then: '`Choose how to continue`' },
        { if: 'stop w toku albo park', then: 'byline stopu (`Stopping ...`, `Finishing T003`, `Stopped before T004 · 2 of 5 briefs complete`)' },
        { if: 'halt bez panelu', then: '`Run stopped`' },
        { if: 'pytanie albo karta potwierdzenia', then: '`Waiting for your answer` + etap' },
        { if: 'cancelled', then: '`Stopped by you` albo `Build failed`' },
        { if: 'interrupted', then: '`Interrupted — finishing current step…`' },
        { if: 'paused bez parku (kontynuacja)', then: '`Resuming T003`' },
        { if: 'cisza seat-a i brak bloku postępu', then: '`No output for 12:30`' },
        { if: 'praca live', then: 'spinner + czynność (np. `Review · Reviewer check V1 · npm test`) + zegar etapu' }
      ],
      default: 'Etap i ułamek passed (np. `Build 2/5`).',
      notes: 'Byline podany przez ekran (at rest, Apply, closed) zastępuje te wszystkie, chyba że trwa stop. Zegar etapu odejmuje czas czekania na użytkownika.'
    },
    {
      id: 'UI_PROGRESS_ROWS',
      title: 'Blok postępu pod paskiem etapów',
      question: 'Czy pokazać blok postępu i ile ma wierszy?',
      where: 'src/features/workflow/layout/chrome-rows.ts:43',
      inputs: ['phase', 'cancelled', 'halt', 'karta nad composerem', 'at rest', 'parked', 'szerokość'],
      branches: [
        { if: 'cancelled, halt, at rest albo parked', then: '0 wierszy' },
        { if: 'otwarta karta, pytanie albo stop-sheet', then: '0 wierszy (karta potrzebuje miejsca)' },
        { if: 'faza nie jest implementer ani final-review', then: '0 wierszy' },
        { if: 'szerokość od 120 kolumn', then: '2 wiersze: liczniki + czynność ze świeżością' },
        { if: 'węziej', then: '3 wiersze: liczniki, czynność, świeżość' }
      ],
      default: '0.',
      notes: 'Liczniki: `2/5 briefs passed · 1 escalated · attempt 2 of 3` (attempt dopiero od drugiej próby). Świeżość: `running 0:12`, `No output for 1:05` (od 60 s), `last event 5s ago`. Brak ETA.'
    },
    {
      id: 'UI_RAIL_AT_REST',
      title: 'Pasek etapów runu w spoczynku',
      question: 'Jakie znaki dostają etapy Plan, Build, Review, Apply?',
      where: 'src/features/workflow/at-rest.ts:61',
      inputs: ['record.status', 'recordPhase', 'workspace'],
      branches: [
        { if: 'running', then: 'etap z fazy rekordu' },
        { if: 'ready-to-apply', then: 'trzy etapy done, Apply pending' },
        { if: 'closed jako complete, applied, undone', then: 'wszystkie done (Apply done albo cancelled)' },
        { if: 'closed inaczej (ended, discarded)', then: 'etap zatrzymania z × (cancelled)' },
        { if: 'open, stop na Apply', then: 'trzy done, Apply z ✗ albo ×' },
        { if: 'open', then: 'etap zatrzymania z ✗ (halt, failed) albo × (inny stop)' }
      ],
      default: '—',
      notes: 'Nieudane final review to etap Review, nigdy done, dopóki nie ma Accept as is. Apply pojawia się tylko dla worktree / staged-copy; zakończony run (ended) nie ma etapu Apply.'
    },
    {
      id: 'UI_FALLBACK_OPEN',
      title: 'Settings › Fallback: gdzie otwiera się picker',
      question: 'Na czym ląduje kursor pickera fallbacku?',
      where: 'src/features/crew/rows.ts:103',
      inputs: ['seatFallback(config, role)'],
      branches: [
        { if: 'fallback ma model (nie auto)', then: 'picker fallbacku na osi modelu z effort / variant' },
        { if: 'fallback ma tylko tool', then: 'picker na wierszu narzędzia' },
        { if: 'brak fallbacku', then: 'picker na wierszu `None`' }
      ],
      default: '—',
      notes: 'Wiersz Fallback (deriveFallbackRows, src/core/crew/fallback.ts:90) pokazuje tożsamość albo `none · pause and ask`, REVIEW bez własnego bloku dziedziczy fallback PLAN. Notatka: `same as the seat`, `not installed`, stan gotowości albo `needs sign-in`.'
    },
    {
      id: 'UI_FALLBACK_COMMIT',
      title: 'Zapis wyboru w slocie fallback',
      question: 'Co zapisuje picker w slocie fallback?',
      where: 'src/features/runners/use-picker-actions.ts:451',
      inputs: ['wybrany wiersz', 'obecny fallback', 'seat'],
      branches: [
        { if: '`None` i brak fallbacku', then: 'zamknięcie bez zapisu' },
        { if: '`None` i jest fallback', then: 'usunięcie: `... fallback · none · Seat down pauses and asks`' },
        { if: 'ten sam tool i model co seat', then: 'błąd `X runs <seat> now · choose another tool or model` (use-picker-actions.ts:420)' },
        { if: 'inny tool lub model', then: '`commitFallbackSelection` + zapis config.yaml', next: 'UI_SEAT_CHANGE_POINT' }
      ],
      default: '—',
      notes: 'W slocie fallback nie da się usuwać własnych modeli (deleteRight nic nie robi).'
    },
    {
      id: 'UI_SEAT_CHANGE_POINT',
      title: 'Zmiana seat-a w trakcie runu',
      question: 'Od kiedy działa seat zapisany w pickerze?',
      where: 'src/features/runners/use-picker-actions.ts:220',
      inputs: ['tożsamości seatów przed i po', 'preparationStore', 'execution', 'takesSeatAtBoundary'],
      branches: [
        { if: 'tożsamość się nie zmieniła', then: '`Saved ... to .splitbrief/config.yaml`' },
        { if: 'start jeszcze sprawdza narzędzia', then: '`<SEAT> seat changes after the next brief`' },
        { if: 'run local biegnie albo parked, bez haltu', then: '`<SEAT> seat changes after T003` (albo `after a fix brief or at the next run`); run zatrzymuje się na granicy briefu i re-preparuje' },
        { if: 'halt albo brak runu', then: 'zwykły komunikat zapisu; halt czyta seat przy wznowieniu' }
      ],
      default: 'Zwykły zapis.',
      notes: 'Pętla runu słucha configStore (use-run-loop.ts:298) – ręczna edycja pliku też się liczy.'
    },
    {
      id: 'UI_EVENT_DROP',
      title: 'Które zdarzenia trafiają do store-ów',
      question: 'Czy zdarzenie silnika zmienia stan UI?',
      where: 'src/stores/workflow/actions/event.ts:22',
      inputs: ['event.type', 'lifecycle.cancelled'],
      branches: [
        { if: '`cost_update`', then: 'tylko tokensStore' },
        { if: 'run anulowany i event nie jest jednym z: workflow_cancelled, turn_interrupted, review_completed, runner_call_error / completed / warning / usage / session_id / artifact', then: 'odrzucony' },
        { if: 'inaczej', then: 'events (rzutowany log) → tasks → tokens → lifecycle → operations, synchronicznie' }
      ],
      default: '—',
      notes: 'Podpięcie: `bus.subscribe(tuiSink)` w src/engine/orchestrator/run/init-sinks.ts:35. Komendy at rest (Apply, Discard, End run) budują własny `createRecoveryBus` z tym samym sinkiem.'
    },
    {
      id: 'UI_SETUP_FINALIZE',
      title: 'Setup: Continue',
      question: 'Co robi Continue na ekranie setup?',
      where: 'src/app/screens/setup.tsx:651',
      inputs: ['niedostępne seaty', 'onComplete', 'czekający feature'],
      branches: [
        { if: 'jakiś seat niedostępny', then: '`Choose a ready tool and model for each unavailable seat.`' },
        { if: 'zapis configu nieudany', then: 'błąd zapisu' },
        { if: 'onComplete workflow i jest feature', then: 'przygotowanie runu, potem workflow local' },
        { if: 'inaczej', then: 'home + `Saved your crew to .splitbrief/config.yaml`' }
      ],
      default: '—',
      notes: 'Esc na kroku discovery i wyjście z kroku crew zamykają aplikację (`exit`). Esc w czasie przygotowania anuluje próbę i wraca do crew. → zobacz startup.'
    }
  ],
  config: [
    { key: 'palette.customActions', values: 'lista { id, label, description?, command: "/..." }', default: 'brak', effect: 'Dodatkowe wiersze palety; wybór uruchamia `command` jako komendę runtime (ta sama ścieżka dispatchu i guard-ów).', where: 'src/core/schemas/config.ts:17' },
    { key: 'workflow.approve', values: 'plan | none', default: 'plan', effect: 'plan: silnik otwiera plan card (`onApprovalNeeded`); none: karta się nie pokazuje. Wiersz `Plan approval` w Settings › Workflow.', where: 'src/core/settings/catalog.ts:77' },
    { key: 'validation.approve_checks', values: 'ask | auto', default: 'auto', effect: 'ask: karta `Reviewer checks` z Run all / Skip all przed review; auto: bez karty. Wiersz `Approve checks` w Settings › Validation.', where: 'src/core/settings/catalog.ts:121' },
    { key: 'validation.end_checks', values: 'true | false', default: 'true', effect: 'Wiersz `End-of-run checks` w Settings; wyłączone = reviewer nie wybiera checków, karta się nie pojawi.', where: 'src/core/settings/catalog.ts:112' },
    { key: 'workflow.isolation', values: 'worktree | staged-copy | none', default: 'worktree', effect: 'Tylko worktree i staged-copy dają stan ready-to-apply, menu wyniku i etap Apply na pasku. none: zaliczone review zamyka run bez Apply.', where: 'src/core/settings/catalog.ts:102' },
    { key: 'planner.fallback / implementer.fallback / reviewer.fallback', values: '{ tool, model?, effort?, variant? }', default: 'brak (none · pause and ask)', effect: 'Zapisywane tylko przez picker w slocie fallback (Settings › Fallback). REVIEW bez bloku reviewer dziedziczy fallback PLAN.', where: 'src/core/crew/fallback.ts:44' },
    { key: 'Settings: Tuning / Workflow / Validation', values: 'implementer.temperature, implementer.contextLength, implementer.timeout, workflow.compactionFormat, workflow.git.createBranch, validation.testCommand', default: 'zależnie od klucza', effect: 'Wiersze Settings po Crew i Fallback; ⏎ przełącza boolean / enum albo edytuje liczbę lub tekst; zapis kolejkowany, żeby nie zgubić rewizji.', where: 'src/core/settings/catalog.ts:41' },
    { key: '.splitbrief/ui-prefs.json: sidebarVisible', values: 'true | false', default: 'true', effect: '`/sidebar` przełącza i zapisuje. Sidebar maluje się tylko powyżej 120 kolumn i nigdy na zamkniętym runie.', where: 'src/app/command-context.ts:446' },
    { key: 'VISUAL / EDITOR / PAGER', values: 'komenda edytora / pagera', default: 'vi; less dla Show diff', effect: 'Edytor dla `ctrl+o` w edytorze planu (VISUAL ma pierwszeństwo). Show diff: VISUAL lub EDITOR, inaczej PAGER albo less.', where: 'src/features/workflow/editor-command.ts:159' },
    { key: 'FORCE_HYPERLINK', values: '0 | 1 / wartość env', default: 'wykrywanie terminala', effect: 'Wymusza albo wyłącza linki OSC 8 dla ścieżek w transkrypcie.', where: 'src/lib/terminal/hyperlinks.ts:7' }
  ],
  states: [
    { name: 'screen: home', meaning: 'Composer na nowy feature, ostatnie sesje (ctrl+r), panel discovery przy zimnym starcie.', where: 'src/app/screens/home.tsx:173' },
    { name: 'screen: setup', meaning: 'Pierwsze uruchomienie: krok discovery, potem krok crew (gotowe crew + seaty).', where: 'src/app/screens/setup.tsx:537' },
    { name: 'screen: workflow · local', meaning: 'Ten proces prowadzi run: live byline, blok postępu, karty silnika.', where: 'src/stores/navigation/router.ts:15' },
    { name: 'screen: workflow · at-rest', meaning: 'Run z dysku: open, ready-to-apply, closed albo running w innym procesie.', where: 'src/stores/navigation/router.ts:22' },
    { name: 'InputMode: normal / review / question', meaning: 'normal = kolejka lub komendy; review = plan card; question = pytanie plannera albo menu recovery.', where: 'src/core/navigation/types.ts:7' },
    { name: 'StopPhase: idle → requested → terminating / forcing → settling → parked / ended / failed', meaning: 'Postęp stopu widoczny w byline i w wierszach stop-sheet.', where: 'src/stores/workflow/stop.ts:7' },
    { name: 'StopIntent: none / stop-now / pause-after-brief / end-run / quit', meaning: 'Co użytkownik poprosił: zatrzymaj teraz, pauza po briefie, zamknij run, wyjdź.', where: 'src/stores/workflow/stop.ts:6' },
    { name: 'Departure: home / quit', meaning: 'Zakolejkowane wyjście czekające na Apply albo na koniec stopu.', where: 'src/stores/workflow/departure.ts:3' },
    { name: 'OverlayType', meaning: 'none, help, command-palette, skills, settings, 3 pickery seat, 3 pickery fallback, stop-sheet, sessions, usage-details, editor.', where: 'src/core/navigation/types.ts:61' }
  ],
  scenarios: [
    {
      title: 'Nowy feature od home do Apply (ścieżka szczęśliwa)',
      steps: [
        '1. Na home wpisujesz opis i ⏎. `prepareExecution` sprawdza narzędzia; byline home pokazuje etap sprawdzania i `esc cancel`.',
        '2. `navigate` do workflow local. Byline: spinner + czynność plannera + zegar.',
        '3. Planner zadaje pytania: panel QuestionPrompt. ↑↓ wybiera, ⏎ odpowiada; po ostatnim pytaniu paczka Q/A wraca do plannera.',
        '4. Plan card: ⏎ na `Approve plan and start the build`.',
        '5. Build: pod paskiem etapów blok postępu `1/3 briefs passed` i czynność seat-a. Tekst + ⏎ trafia do kolejki BUILD.',
        '6. Final review przechodzi; pętla wraca, `settleRun` przełącza na at-rest. Rekord `ready-to-apply`: menu wyniku `Ready to apply · 4 files changed`.',
        '7. ⏎ na `Apply` → `/run accept`. Byline `Applying to your checkout · 0:03`, Apply aktywny na pasku.',
        '8. Feedback `Applied 4 files to your checkout.`; blok `Closed ─` na końcu transkryptu, ⏎ wraca do home.'
      ],
      outcome: 'Run closed jako applied; byline `Undo the Apply with /run reject confirm`.'
    },
    {
      title: 'esc esc esc na pracującym runie',
      steps: [
        '1. Pierwszy esc (po 25 ms) otwiera `Stop options`: Stop now, Pause after this brief, End run.',
        '2. Drugi esc przy otwartym menu: menu się zamyka i idzie `requestStopNow`. Byline `Stopping T002 · Waiting for processes to exit · 0:02`.',
        '3. Trzeci esc: stop jest w toku, więc `requestLeaveSession`. Wyjście czeka na park.',
        '4. Park ląduje, szkic zapisuje się do draft.json, ekran przechodzi na home.'
      ],
      outcome: 'Run zostaje otwarty (stopped) i continuable; szybkie esc esc esc w jednym chunku robi to samo naraz.'
    },
    {
      title: 'ctrl+c w trakcie Apply',
      steps: [
        '1. Apply pisze do checkoutu. Pierwsze ctrl+c: activeApply() istnieje, więc od razu `requestQuit`.',
        '2. departureStore dostaje quit; byline `Applying to your checkout · Quits when Apply finishes · 0:05`.',
        '3. Esc teraz nic nie zmienia: home za quit nie wchodzi do kolejki.',
        '4. Apply kończy się haltem: zakolejkowany quit i tak wychodzi (zakolejkowany home zostałby porzucony, żeby było widać halt).'
      ],
      outcome: 'Aplikacja kończy się po Apply; nic nie przerwało zapisu.'
    },
    {
      title: 'Seat down bez fallbacku: zmiana narzędzia z menu recovery',
      steps: [
        '1. BUILD trafia na limit konta; halt nie ma `switchSeat.auto`, więc menu recovery w trybie pytania. Byline `Choose how to continue`.',
        '2. Wciskasz `w` (switch-seat). Otwiera się `implementer-picker` na wierszu oferowanego narzędzia.',
        '3. Esc w pickerze: wybór anulowany, menu pyta znowu.',
        '4. Drugi raz `w`, wybierasz inny model i ⏎. Config zapisany, `switchSeat` wraca do pętli runu.',
        '5. Run re-preparuje się na nowym seat-cie i powtarza brief.'
      ],
      outcome: 'Run idzie dalej na nowym narzędziu; decyzja o fallbacku i limicie → zobacz recovery.'
    },
    {
      title: 'Ustawienie fallbacku dla PLAN w Settings',
      steps: [
        '1. ctrl+, otwiera Settings: Crew, potem Fallback z wierszem `fallback:plan` = `none · pause and ask`.',
        '2. ⏎ na wierszu: `planner-fallback-picker` na wierszu `None`.',
        '3. Wybierasz ten sam tool i model co PLAN: błąd `PLAN runs ... now · choose another tool or model`.',
        '4. Wybierasz inny model: zapis, feedback `Saved PLAN fallback · <tool> · <model> to .splitbrief/config.yaml`, picker zamyka się do Settings.',
        '5. Później `None` na tym wierszu usuwa fallback: `Seat down pauses and asks`.'
      ],
      outcome: 'Fallback zapisany w config; wiersz Crew dalej nie pokazuje fallbacku.'
    },
    {
      title: 'Zmiana seat-a BUILD w trakcie briefu',
      steps: [
        '1. Run biegnie na T003. `/crew build` otwiera picker BUILD.',
        '2. Wybierasz inny model. Zapis się udaje, feedback `BUILD seat changes after T003`.',
        '3. stopStore dostaje seatChange; na granicy briefu run zatrzymuje się sam i kontynuuje re-preparowany z zapisanego configu.'
      ],
      outcome: 'T004 startuje na nowym seat-cie bez pauzy; seat zapisany przy otwartym haltcie działa dopiero przy wznowieniu.'
    },
    {
      title: '/end w czasie checków briefu',
      steps: [
        '1. Faza `validating-task` (checki briefu). Wpisujesz `/end`.',
        '2. Guard: faza nie jest live, run nie jest at rest → `No run to end in this phase`; `/end` znika też z palety.',
        '3. Esc otwiera stop-sheet, wiersz `End run` działa normalnie (`requestEndRun`).'
      ],
      outcome: 'Run zamknięty przez stop-sheet; komenda `/end` czeka na fazę live.'
    },
    {
      title: 'Szkic nie zapisuje się przy wyjściu',
      steps: [
        '1. draft.json nie daje się zapisać (np. brak praw do katalogu sesji).',
        '2. Esc do home: `flushSessionDrafts` rzuca błąd; ekran zostaje, na końcu transkryptu blok `Warning` z przyczyną i plikiem, feedback `Draft not saved · esc or quit again leaves without it`.',
        '3. Drugi esc z tego samego ekranu: szkic porzucony, wyjście do home.'
      ],
      outcome: 'Wychodzisz bez szkicu po świadomym drugim wyjściu.'
    },
    {
      title: 'Otwarcie zamkniętego runu z /sessions',
      steps: [
        '1. `/sessions`, wybierasz zamknięty run. `handleSessionSelect` odtwarza historię i nawiguje na workflow at-rest.',
        '2. Transkrypt kończy blok `Closed ─` z Briefs, Files, Run. Sidebar się nie pokazuje.',
        '3. `/sidebar` → `A closed run has no sidebar.`; litera w composerze → `Only /commands here · ⏎ on an empty line goes home`.',
        '4. Pusty ⏎ → home.'
      ],
      outcome: 'Run tylko do czytania i komend.'
    },
    {
      title: 'Reviewer checks z approve_checks: ask',
      steps: [
        '1. Przed final review karta `Reviewer checks · chose 2 · none has run yet` z listą komend.',
        '2. Tab przenosi klawisze do composera; pusty ⏎ wraca do karty.',
        '3. ⏎ na `Skip all`: silnik dostaje `skip`; żaden check nie liczy się jako pass.'
      ],
      outcome: 'Review biegnie bez checków; zamknięcie karty przez stop daje undefined, nie Run.'
    }
  ],
  files: [
    { path: 'src/app/root.tsx', role: 'App: Router, globalne klawisze, komendy, mysz' },
    { path: 'src/app/router.tsx', role: 'renderScreen / renderOverlay → Layout' },
    { path: 'src/app/layout.tsx', role: 'ukrywa ekran pod overlayem, ekran zostaje zamontowany' },
    { path: 'src/app/keys.ts', role: 'esc ladder, ctrl+c, skróty globalne' },
    { path: 'src/app/command-context.ts', role: 'kontekst komend, /run accept / reject, łańcuch komend' },
    { path: 'src/app/mouse.ts', role: 'routing myszy: overlay, prompt, transkrypt' },
    { path: 'src/stores/navigation/router.ts', role: 'trasy, dozwolone przejścia, execution local / at-rest' },
    { path: 'src/stores/navigation/session-select.ts', role: 'handleSessionSelect, continueRunInPlace' },
    { path: 'src/stores/ui/overlay.ts', role: 'stos overlayów' },
    { path: 'src/stores/ui/session-drafts.ts', role: 'draft.json, odmowa wyjścia przy błędzie zapisu' },
    { path: 'src/stores/workflow/stop.ts', role: 'StopIntent / StopPhase, park, seatChange' },
    { path: 'src/stores/workflow/departure.ts', role: 'kolejka wyjścia home / quit' },
    { path: 'src/stores/workflow/actions/event.ts', role: 'addEvent: fan-out zdarzeń do store-ów' },
    { path: 'src/stores/approval-prompt/prompt.ts', role: 'kanał karty potwierdzenia zapisu' },
    { path: 'src/stores/question-prompt/prompt.ts', role: 'pytania plannera, paczka odpowiedzi' },
    { path: 'src/stores/review-checks-prompt/prompt.ts', role: 'kanał karty Reviewer checks' },
    { path: 'src/core/runtime/commands/registry.ts', role: 'lista 23 komend' },
    { path: 'src/core/runtime/commands/dispatch.ts', role: 'lookup → removed → screen → guard → handler' },
    { path: 'src/core/runtime/commands/defs/workflow.ts', role: '/stop, /resume, /steer, /end, /queue, /run i ich guardy' },
    { path: 'src/core/navigation/types.ts', role: 'ekrany, overlaye, tokeny fokusu' },
    { path: 'src/core/keybindings/registry.ts', role: 'opis skrótów dla pomocy' },
    { path: 'src/components/composer/composer.tsx', role: 'wysyłanie: komenda, odpowiedź, pusty ⏎, ctrl+⏎' },
    { path: 'src/features/workflow/handlers.ts', role: 'requestStopNow, requestEndRun, requestSteer, requestDeparture' },
    { path: 'src/features/workflow/prompt-callbacks.ts', role: 'callbacki silnika → karty UI' },
    { path: 'src/features/workflow/hooks/use-input-mode.ts', role: 'tryby normal / review / question i ich promise' },
    { path: 'src/features/workflow/review-parser.ts', role: 'tekst w trybie normal i na plan card' },
    { path: 'src/features/workflow/recovery-driver.ts', role: 'menu recovery, auto switch, switch-seat przez picker' },
    { path: 'src/features/workflow/stop/options.ts', role: 'wiersze stop-sheet' },
    { path: 'src/features/workflow/result/menu.tsx', role: 'menu wyniku Apply / Show diff / Discard' },
    { path: 'src/features/workflow/at-rest.ts', role: 'composer i pasek etapów runu w spoczynku' },
    { path: 'src/features/workflow/closed/byline.ts', role: 'byline at rest, Apply, closed; placeholdery' },
    { path: 'src/features/workflow/components/input-footer.tsx', role: 'byline live: kolejność głosu' },
    { path: 'src/features/workflow/display/build-progress.ts', role: 'blok postępu: liczniki, czynność, świeżość' },
    { path: 'src/features/workflow/hooks/workflow-screen/use-model.ts', role: 'model ekranu workflow: handleInput, onEmptySubmit' },
    { path: 'src/app/screens/workflow.tsx', role: 'układ ekranu, które menu nad composerem, fokus kart' },
    { path: 'src/features/crew/rows.ts', role: 'crewActivate, fallbackActivate' },
    { path: 'src/core/crew/fallback.ts', role: 'deriveFallbackRows i notatki' },
    { path: 'src/features/runners/use-picker-actions.ts', role: 'zapis seat / fallback, punkt zmiany seat-a' },
    { path: 'src/app/overlays/runners.tsx', role: 'ToolModelPicker: 3 role × 2 sloty' },
    { path: 'src/features/palette/sources.ts', role: 'źródła palety i ukrywanie przez guard' }
  ],
  gotchas: [
    '`/home` bez Apply nawiguje od razu, bez drabiny stopu (src/app/command-context.ts:363). Na pracującym runie ekran workflow się odmontowuje, a sprzątanie efektu robi `controller.abort()` (src/features/workflow/hooks/use-run-loop.ts:585). To ten sam abort co Stop now, ale bez czekania na park i bez `settleRun` na ekranie. Esc i `/quit` czekają na stop; `/home` nie.',
    'Komunikat commands-only `Only /commands here · ⏎ on an empty line goes home` (src/components/composer/composer.tsx:79) jest nieprawdziwy na runie ready-to-apply: tam pusty ⏎ nie idzie do domu, tylko wraca fokusem do menu wyniku (src/app/screens/workflow.tsx:539). Klasa 2 (mylący tekst).',
    '`/resume`, `/steer` i `/end` są zablokowane w fazach, które nie są live: m.in. `reviewing-plan` (plan card) i `validating-task` (checki briefu) – `No run to end in this phase`. Stop-sheet (esc) i wiersz End run na plan card dalej działają.',
    'Guard komendy robi dwie rzeczy: blokuje wpisaną komendę i ukrywa jej wiersz w palecie, pomocy i liście `/`. Komenda „znika”, gdy nie może działać.',
    '23 komendy obejmują ukrytą `/palette`; paleta pokazuje najwyżej 22.',
    'ctrl+c ma handler bez warunku aktywności: działa także przy otwartym overlayu. ctrl+q i pozostałe skróty działają tylko bez overlay-a, bez karty potwierdzenia i bez trwającego przygotowania.',
    'Okno debounce esc to 25 ms (src/lib/terminal/escape-debounce.ts:1). Wolny drugi esc nie jest „szybkim drugim esc”, ale trafia w otwarty stop-sheet i też robi Stop now (src/app/keys.ts:345).',
    'Karty (potwierdzenie, pytania) ignorują klawisze przez 150 ms po otwarciu (PROMPT_TYPEAHEAD_GRACE_MS), żeby tekst wpisany z wyprzedzeniem nie odpowiedział za ciebie.',
    'Esc na karcie potwierdzenia zapisu to Deny (`user_denied`) – odpowiedź, nie stop. Zamknięcie karty przez stop daje `user_cancelled`.',
    'Fallback wybiera się tylko w Settings › Fallback (picker w slocie fallback). Wiersz Crew i ekran Setup nigdy nie pokazują fallbacku. Picker fallbacku odmawia wyboru identycznego z seatem.',
    'switch-seat z menu recovery nie ma własnej listy narzędzi: otwiera ten sam picker seat-a na oferowanym narzędziu. Esc w pickerze albo wybór tego samego seat-a = anulowanie, menu pyta znowu.',
    'Stop, który się nie udał, sam otwiera stop-sheet z jednym wierszem `Retry stop` (use-run-loop.ts:569). Stop zakończony parkiem też sam otwiera sheet z Resume / End run / Back to sessions (use-run-loop.ts:661).',
    'Litery nie wybierają akcji w menu wyniku, w stop-sheet ani w karcie checks. W menu recovery i w karcie potwierdzenia litery działają.',
    'Ekran at rest sam czyta rekord ponownie, gdy inny proces zmieni state.json, lock, session.jsonl albo summary (watchFile co 100 ms), więc run zamknięty w innym oknie zmienia się na ekranie bez akcji.'
  ]
});
