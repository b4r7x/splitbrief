window.ATLAS = window.ATLAS || [];
window.ATLAS.push({
  id: 'startup',
  order: 1,
  title: 'Start: CLI, konfiguracja i gotowość',
  tagline: 'Co się dzieje od wpisania splitbrief start "..." do pierwszego wywołania plannera i każdy powód, dla którego start się zatrzymuje.',
  summary: `**Ten obszar to droga od wiersza poleceń do sesji planowania.** Plik \`src/cli.ts\` sprawdza wersję Node, odrzuca usunięte flagi i komendy oraz literówki, a potem commander uruchamia jedną z ośmiu komend: \`start\` (domyślna), \`spec\`, \`init\`, \`status\`, \`resume\`, \`doctor\`, \`review\`, \`continue\`.

**Komenda start ma dwie drogi.** Bez \`--json\` i \`--plain\` jest to droga TUI: potrzebny TTY, potem \`setupWorkflow\` (repo git, sprzątanie osieroconych procesów, flagi ekranu), potem bootstrap store-ów (config, sesje, zaufanie do hooków) i montaż Ink. Z \`--json\` lub \`--plain\` jest to droga headless: brak ekranu, brak pytania o hooki, automatyczny zapis wykrytej załogi przy braku configu, a na końcu kod wyjścia mówi, jak run się skończył.

**Obie drogi spotykają się w \`prepareExecution\`.** Ta funkcja liczy raport gotowości (config, repo, workflow, seaty, kontekst, walidacja, izolacja, sandbox Claude Code), potem dopuszcza każdy seat osobno (zainstalowany? zalogowany? zaufany? zgodna wersja?), sprawdza argumenty CLI przez \`--help\` i dopiero wtedy tworzy folder sesji i wskaźnik \`.splitbrief/active\`. Każdy bloker zatrzymuje start przed pierwszym płatnym wywołaniem.

**Brudne drzewo robocze nie blokuje.** Daje tylko ostrzeżenie \`repo.dirty-worktree\`. Blokują: brak configu (tylko w \`doctor\`), zły config, brak repo git lub commitów, trwający rebase/merge, inny żywy run, niegotowy seat, brak \`bwrap\`/\`socat\` dla Claude Code jako BUILD na Linuksie oraz monorepo z workspace-ami, gdy \`workflow.isolation\` nie jest ustawione.

**Pierwszy run bez configu:** TUI otwiera ekran Setup („Set up your crew”), który proponuje wykrytą załogę i zapisuje \`.splitbrief/config.yaml\`. Headless start, \`spec\`, \`review\` i \`init --yes\` same wybierają gotową załogę (PLAN: claude-code, potem codex; BUILD: lokalny model Ollama, potem opencode, codex, claude-code) i zapisują ją, albo kończą z prośbą o \`splitbrief init\`.

Po udanym przygotowaniu TUI przechodzi na ekran workflow (\`useRunLoop\` → \`runWorkflow\`), a headless woła \`runWorkflow\` bezpośrednio. \`initializeWorkflow\` robi ostatnie sprawdzenie (\`planner.isAvailable()\`), a \`runPlanningPhases\` zaczyna sesję planowania → zobacz planning.`,
  entry: [
    'src/cli.ts:45',
    'src/cli/commands/start/register.ts:26',
    'src/engine/runners/prepare-execution/prepare-execution.ts:372'
  ],
  links: [
    { to: 'planning', label: 'po prepared: runPlanningPhases zaczyna sesję planowania' },
    { to: 'runners', label: 'dopuszczenie seatu CLI/API/shell: dowody, logowanie, wersja, fabryka' },
    { to: 'lifecycle', label: 'prepareNewSession, wskaźnik active, liveness, resume/continue, Apply/Discard' },
    { to: 'ui', label: 'montaż Ink, ekran home/workflow, Settings, picker seatu' },
    { to: 'recovery', label: 'continue --action skip/retry/switch-seat, --on-seat-down, recovery_required' },
    { to: 'subsystems', label: 'hooki (wykonanie i odmowa zaufania), detekcja, skille, EventBus' },
    { to: 'review', label: 'splitbrief review używa tego samego promptu co końcowy review' }
  ],
  diagrams: [
    {
      id: 'startup-cli-dispatch',
      title: 'Wejście CLI: od argv do komendy',
      caption: 'Najpierw trzy strażniki przed commanderem (Node, usunięte flagi/komendy, literówki), potem wybór komendy. Każdy błąd kończy się w main().catch: Error: <komunikat> i kod z CliError (domyślnie 1).',
      mermaid: `flowchart TD
  A["splitbrief argv"] --> ST_NODE_VERSION{"Node major >= 22?"}
  ST_NODE_VERSION -->|"znana starsza wersja"| X1["requires Node.js 22 or newer<br/>exit 1"]
  ST_NODE_VERSION -->|"tak lub wersja nieczytelna"| ST_RETIRED_FLAG{"Usunięta flaga --mode, --approve, --yolo?"}
  ST_RETIRED_FLAG -->|"tak"| X2["--mode was removed: ...<br/>exit 1"]
  ST_RETIRED_FLAG -->|"nie"| ST_RETIRED_COMMAND{"Pierwszy operand to usunięta komenda?"}
  ST_RETIRED_COMMAND -->|"attach, ps, mcp, approval..."| X3["unknown command ... + zamiennik<br/>exit 1"]
  ST_RETIRED_COMMAND -->|"nie"| ST_MISTYPED_COMMAND{"Jedyny operand bliski nazwie komendy?"}
  ST_MISTYPED_COMMAND -->|"np. doctro"| X4["did you mean doctor?<br/>exit 1"]
  ST_MISTYPED_COMMAND -->|"nie"| P["commander parseAsync<br/>parsery opcji, preAction"]
  P --> ST_OUTPUT_MODE{"--json i --plain naraz?"}
  ST_OUTPUT_MODE -->|"tak"| X5["cannot be combined<br/>exit 2"]
  ST_OUTPUT_MODE -->|"nie"| ST_COMMAND{"Która komenda?"}
  ST_COMMAND -->|"start lub brak nazwy"| C1["start: diagram start"]
  ST_COMMAND -->|"spec"| C2["spec: tylko planowanie"]
  ST_COMMAND -->|"init"| C3["init: Setup lub --yes"]
  ST_COMMAND -->|"status"| C4["status: odczyt active"]
  ST_COMMAND -->|"resume"| C5["resume: ostatni run"]
  ST_COMMAND -->|"continue"| C6["continue: run po id + --action"]
  ST_COMMAND -->|"doctor"| C7["doctor: raport gotowości"]
  ST_COMMAND -->|"review"| C8["review: jedno wywołanie reviewera"]
  C1 --> Z["main().catch: Error: komunikat<br/>exit = CliError.exitCode lub 1"]
  C2 --> Z
  C5 --> Z
  C6 --> Z`
    },
    {
      id: 'startup-start-args',
      title: 'Komenda start: argumenty, katalog projektu, @pliki, wybór trybu',
      caption: 'Wszystko tu dzieje się przed jakimkolwiek wywołaniem narzędzia. Kod 2 oznacza błąd wejścia użytkownika; nic nie zostaje zapisane.',
      mermaid: `flowchart TD
  S["splitbrief start feature files..."] --> ST_START_ARGS{"Argumenty poprawne?"}
  ST_START_ARGS -->|"pliki bez opisu"| E1["feature description is empty<br/>exit 2"]
  ST_START_ARGS -->|"--json/--plain bez opisu"| E2["--json requires a feature argument<br/>exit 1"]
  ST_START_ARGS -->|"opis zaczyna się od @"| E3["is a file reference<br/>exit 2"]
  ST_START_ARGS -->|"ok"| ST_PROJECT_ROOT{"Katalog leży w repo git?"}
  ST_PROJECT_ROOT -->|"tak, podkatalog"| R1["projectDir = toplevel repo<br/>przy --project ostrzeżenie"]
  ST_PROJECT_ROOT -->|"nie albo root"| R2["projectDir = podana ścieżka"]
  R1 --> ST_AT_FILES{"Są argumenty @plik?"}
  R2 --> ST_AT_FILES
  ST_AT_FILES -->|"któryś odrzucony"| E4["SPLITBRIEF refused these @file inputs<br/>exit 2"]
  ST_AT_FILES -->|"brak lub wszystkie ok"| ATT["tekst do plannerContext<br/>obrazy do attachmentsStore"]
  ATT --> ST_HEADLESS_MODE{"--json lub --plain?"}
  ST_HEADLESS_MODE -->|"tak"| H["runHeadlessStart: diagram headless"]
  ST_HEADLESS_MODE -->|"nie"| I["runInteractiveStart: diagram TUI<br/>diagnostyka wstrzymana do montażu"]`
    },
    {
      id: 'startup-interactive',
      title: 'Start w TUI: od TTY do ekranu workflow',
      caption: 'Zaufanie do hooków jest pytane w zwykłym terminalu (readline na stderr) przed montażem Ink. Gdy przygotowanie zablokuje start z wiersza poleceń, TUI się zamyka, a raport blokerów trafia na stdout.',
      mermaid: `flowchart TD
  I0["runInteractiveStart"] --> ST_TTY{"stdin to TTY?"}
  ST_TTY -->|"nie"| E1["interactive mode needs a TTY<br/>exit 1"]
  ST_TTY -->|"tak"| ST_GIT_REPO{"Projekt to repo git?"}
  ST_GIT_REPO -->|"nie"| E2["not a git repository<br/>exit 1"]
  ST_GIT_REPO -->|"tak"| REAP["reapOrphanRunners<br/>ST_RENDER_FLAGS: fullscreen, mouse, hover"]
  REAP --> ST_NEEDS_SETUP{"Plik .splitbrief/config.yaml istnieje?"}
  ST_NEEDS_SETUP -->|"nie: needsSetup"| B["initStoresForTuiMount"]
  ST_NEEDS_SETUP -->|"tak"| B
  B --> CFG["configStore.load: diagram konfiguracji"]
  CFG -->|"błąd configu"| E3["Error: Unsupported config version ...<br/>exit 1"]
  CFG -->|"ok"| ST_HOOK_TRUST{"Hooki zaufane?"}
  ST_HOOK_TRUST -->|"odmowa, brak TTY, symlink"| E4["Refusing to run with untrusted hooks<br/>exit 1"]
  ST_HOOK_TRUST -->|"brak hooków, receipt, y, --allow-hooks"| ST_INTERACTIVE_ROUTE{"needsSetup, feature czy nic?"}
  ST_INTERACTIVE_ROUTE -->|"needsSetup"| ST_LIVE_SESSION_TUI{"Inny run żyje?"}
  ST_INTERACTIVE_ROUTE -->|"brak feature"| ST_LIVE_SESSION_TUI
  ST_LIVE_SESSION_TUI -->|"tak"| E5["session ... is still active<br/>exit 1"]
  ST_LIVE_SESSION_TUI -->|"nie, needsSetup"| SETUP["Ekran Setup: diagram pierwszego uruchomienia"]
  ST_LIVE_SESSION_TUI -->|"nie, bez feature"| HOME0["Ekran home"]
  ST_INTERACTIVE_ROUTE -->|"feature"| HOME["Ink montuje home<br/>preparationStore.submit: Checking tools"]
  HOME --> PREP["prepareStartOutcome: diagram gotowości"]
  PREP --> ST_PREP_SUPERSEDE{"Ta próba wciąż jest bieżąca?"}
  ST_PREP_SUPERSEDE -->|"nie: wyparta przez nowszą"| ROLL["rollback własnej sesji<br/>TUI zostaje"]
  ST_PREP_SUPERSEDE -->|"tak"| ST_PREP_OUTCOME{"Wynik przygotowania?"}
  ST_PREP_OUTCOME -->|"prepared"| WF["navigate workflow<br/>useRunLoop: runWorkflow"]
  ST_PREP_OUTCOME -->|"blocked"| UNM["zamknij TUI, blokery na stdout<br/>Run readiness blocked ... exit 1"]
  ST_PREP_OUTCOME -->|"failed"| FAIL["zamknij TUI, Error: ...<br/>exit 1"]
  ST_PREP_OUTCOME -->|"aborted"| IDLE["stan idle, TUI zostaje"]
  WF --> PL["initializeWorkflow, runPlanningPhases: obszar planning"]`
    },
    {
      id: 'startup-readiness',
      title: 'Raport gotowości: co blokuje, co tylko ostrzega',
      caption: 'collectReadiness liczy wszystkie sekcje naraz. Kolejność na rysunku to kolejność czytania, nie wykonania. Status to blocked przy co najmniej jednym blokerze, ready-with-warnings przy ostrzeżeniach, inaczej ready.',
      mermaid: `flowchart TD
  C0["prepareStartOutcome: resolveRunConfig"] --> ST_CLEAR_STALE{"Wskaźnik active wskazuje żywy run?"}
  ST_CLEAR_STALE -->|"martwy"| CLR["usuń .splitbrief/active"]
  ST_CLEAR_STALE -->|"żywy"| KEEP["zostaw, raport go zgłosi"]
  CLR --> COL["collectReadiness"]
  KEEP --> COL
  COL --> ST_CONFIG_CHECK{"Config: loaded, missing, invalid?"}
  ST_CONFIG_CHECK -->|"missing lub invalid"| BL["BLOKER"]
  ST_CONFIG_CHECK -->|"loaded"| ST_REPO_CHECK{"Repo git z commitami, bez operacji git w toku?"}
  ST_REPO_CHECK -->|"nie"| BL
  ST_REPO_CHECK -->|"detached HEAD"| W["OSTRZEŻENIE"]
  ST_REPO_CHECK -->|"tak"| ST_ACTIVE_SESSION{"Inny run aktywny?"}
  ST_ACTIVE_SESSION -->|"żywy"| BL
  ST_ACTIVE_SESSION -->|"martwy lub brak"| ST_DIRTY_WORKTREE{"Zmienione lub nieśledzone pliki?"}
  ST_DIRTY_WORKTREE -->|"tak"| W
  ST_DIRTY_WORKTREE -->|"nie"| ST_PLAN_APPROVAL{"approve: plan i headless?"}
  ST_PLAN_APPROVAL -->|"tak"| INF["INFO: plan zatwierdzany automatycznie"]
  ST_PLAN_APPROVAL -->|"nie"| ST_CONTEXT_LENGTH{"contextLength poniżej 32000?"}
  INF --> ST_CONTEXT_LENGTH
  ST_CONTEXT_LENGTH -->|"tak"| W
  ST_CONTEXT_LENGTH -->|"nie lub auto"| ST_END_CHECKS{"validation.end_checks wyłączone?"}
  ST_END_CHECKS -->|"tak"| W
  ST_END_CHECKS -->|"nie"| ST_ISOLATION_STACK{"Workspaces, editable venv, go.work lub Cargo workspace?"}
  ST_ISOLATION_STACK -->|"tak, isolation nieustawione"| BL
  ST_ISOLATION_STACK -->|"tak, worktree lub staged-copy"| W
  ST_ISOLATION_STACK -->|"nie albo isolation none"| ST_SANDBOX{"Linux, BUILD claude-code, brak bwrap lub socat?"}
  ST_SANDBOX -->|"domyślny profil BUILD"| BL
  ST_SANDBOX -->|"inny profil"| W
  ST_SANDBOX -->|"nie"| ST_READINESS_STATUS{"Liczba blokerów > 0?"}
  BL --> ST_READINESS_STATUS
  W --> ST_READINESS_STATUS
  ST_READINESS_STATUS -->|"tak"| OUTB["outcome blocked"]
  ST_READINESS_STATUS -->|"nie"| ADM["admitRunners: diagram dopuszczenia seatów"]`
    },
    {
      id: 'startup-admission',
      title: 'Dopuszczenie seatów i utworzenie sesji',
      caption: 'Każdy seat dostaje własny werdykt (runners.preparation.<slot>). Jeden zablokowany seat blokuje cały start. Szczegóły dowodów CLI → zobacz runners.',
      mermaid: `flowchart TD
  A0["runnerCandidates"] --> ST_CANDIDATES{"Cel przygotowania?"}
  ST_CANDIDATES -->|"review"| R["tylko seat REVIEW"]
  ST_CANDIDATES -->|"spec"| S["tylko PLAN"]
  ST_CANDIDATES -->|"new-workflow, resume"| N["PLAN + każdy profil BUILD<br/>+ REVIEW gdy skonfigurowany"]
  R --> LOOP["evaluateCandidate dla każdego seatu"]
  S --> LOOP
  N --> LOOP
  LOOP --> ST_RUNNER_KIND{"kind seatu?"}
  ST_RUNNER_KIND -->|"cli"| CLI["detectRunnerEvidence: plik wykonywalny, wersja, logowanie"]
  CLI --> ST_SESSION_AUTH_RETRY{"Odmowa logowania na kanale session?"}
  ST_SESSION_AUTH_RETRY -->|"tak"| RETRY["odczekaj, drugi odczyt"]
  ST_SESSION_AUTH_RETRY -->|"nie"| ST_CLI_ADMISSION{"Werdykt bramki CLI?"}
  RETRY --> ST_CLI_ADMISSION
  ST_CLI_ADMISSION -->|"not installed, not signed in, wersja, niezaufany"| SB["seat could not start"]
  ST_CLI_ADMISSION -->|"logowanie nieznane"| ST_UNVERIFIED_AUTH{"Tryb i --allow-unverified-auth?"}
  ST_UNVERIFIED_AUTH -->|"TUI: disclosed"| OK["seat admitted: gate"]
  ST_UNVERIFIED_AUTH -->|"headless z flagą"| OK
  ST_UNVERIFIED_AUTH -->|"headless bez flagi"| SB
  ST_CLI_ADMISSION -->|"admitted"| OK
  ST_RUNNER_KIND -->|"api"| ST_API_CREDENTIALS{"Zdalny dostawca bez klucza?"}
  ST_API_CREDENTIALS -->|"tak lub zły endpoint"| SB
  ST_API_CREDENTIALS -->|"nie"| OK
  ST_RUNNER_KIND -->|"shell, agent"| ST_CUSTOM_RUNNER{"Komenda dopuszczona?"}
  ST_CUSTOM_RUNNER -->|"repo-local bez --allow-repo-runners, odmowa, brak pliku"| SB
  ST_CUSTOM_RUNNER -->|"receipt, potwierdzenie, grant"| OK
  SB --> ST_SEATS_BLOCKED{"Któryś seat blocked?"}
  OK --> ST_SEATS_BLOCKED
  ST_SEATS_BLOCKED -->|"tak"| BLK["outcome blocked"]
  ST_SEATS_BLOCKED -->|"nie"| ST_REVALIDATE{"Plik wykonywalny CLI wciąż ten sam?"}
  ST_REVALIDATE -->|"zmienił się"| BLK
  ST_REVALIDATE -->|"tak"| ST_ARGV_PREFLIGHT{"Preflight argumentów przez --help ma bloker?"}
  ST_ARGV_PREFLIGHT -->|"tak"| BLK
  ST_ARGV_PREFLIGHT -->|"nie"| SES["prepareNewSession: folder sesji,<br/>readiness.json, wskaźnik active"]
  SES --> PREP["outcome prepared"]
  PREP --> ST_PLANNER_AVAILABLE{"initializeWorkflow: planner.isAvailable?"}
  ST_PLANNER_AVAILABLE -->|"nie"| ERR["error event, run kończy się bez planowania"]
  ST_PLANNER_AVAILABLE -->|"tak"| PLAN["runPlanningPhases: obszar planning"]`
    },
    {
      id: 'startup-config-load',
      title: 'Wczytanie i walidacja .splitbrief/config.yaml',
      caption: 'loadConfig nie zgłasza błędu przy braku pliku: zwraca config domyślny. O tym, czy brak configu blokuje, decyduje wywołujący (Setup, zapis headless, bloker config.missing w doctor).',
      mermaid: `flowchart TD
  L0["loadConfig projectDir"] --> ST_CONFIG_EXISTS{"Plik config.yaml istnieje?"}
  ST_CONFIG_EXISTS -->|"nie"| DEF["createDefaultConfig: PLAN claude-code,<br/>BUILD ollama qwen3-coder:30b"]
  ST_CONFIG_EXISTS -->|"symlink lub nie plik"| ERR0["unreadable lub symlink<br/>błąd"]
  ST_CONFIG_EXISTS -->|"tak"| PERM["prawa pliku: grupa lub inni mogą pisać?<br/>tylko ostrzeżenie chmod 600"]
  PERM --> ST_YAML_PARSE{"YAML poprawny i to obiekt?"}
  ST_YAML_PARSE -->|"nie"| ERR1["invalid YAML lub must be a YAML object"]
  ST_YAML_PARSE -->|"tak"| CAMEL["klucze snake_case na camelCase"]
  CAMEL --> ST_CONFIG_VERSION{"version równe 3?"}
  ST_CONFIG_VERSION -->|"nie"| ERR2["Unsupported config version: X. Supported: 3.<br/>Run splitbrief init --reconfigure"]
  ST_CONFIG_VERSION -->|"tak"| ST_MERGE_DEFAULTS{"BUILD w pliku ma inny kind lub provider niż domyślny?"}
  ST_MERGE_DEFAULTS -->|"tak"| KEEPB["BUILD z pliku bez domieszki"]
  ST_MERGE_DEFAULTS -->|"nie"| MIXB["domyślne pola + pola z pliku"]
  KEEPB --> ST_SCHEMA_VALID{"Schemat i reguły dodatkowe bez błędów?"}
  MIXB --> ST_SCHEMA_VALID
  ST_SCHEMA_VALID -->|"błędy"| ERR3["Configuration errors in .splitbrief/config.yaml:<br/>ścieżka: komunikat"]
  ST_SCHEMA_VALID -->|"ok"| ST_RETIRED_VALUES{"Plik ma wycofane klucze lub wartości?"}
  ST_RETIRED_VALUES -->|"tak"| NOTE["notice: X was retired and is ignored<br/>raz na proces"]
  ST_RETIRED_VALUES -->|"nie"| OUT["Config"]
  NOTE --> OUT
  DEF --> OUT
  OUT --> ST_OVERRIDE_VALID{"Flagi CLI dają poprawny config?"}
  ST_OVERRIDE_VALID -->|"nie"| ERR4["effective config: błąd walidacji<br/>lub zły --planner-effort"]
  ST_OVERRIDE_VALID -->|"tak"| EFF["effective config + ostrzeżenia na stderr"]
  ERR0 --> CALLER["wywołujący: CliError exit 1<br/>doctor: bloker config.invalid"]
  ERR1 --> CALLER
  ERR2 --> CALLER
  ERR3 --> CALLER
  ERR4 --> CALLER`
    },
    {
      id: 'startup-first-run',
      title: 'Pierwsze uruchomienie bez configu: Setup w TUI albo zapis headless',
      caption: 'Dwie drogi do pierwszego config.yaml. TUI pokazuje ekran Set up your crew. Headless, spec, review i init --yes wybierają załogę same i zapisują ją tylko wtedy, gdy każdy seat jest dostępny.',
      mermaid: `flowchart TD
  F0["Brak .splitbrief/config.yaml"] --> ST_FIRST_RUN_PATH{"Która komenda?"}
  ST_FIRST_RUN_PATH -->|"start w TUI, init w TUI"| SUP["Ekran Setup"]
  ST_FIRST_RUN_PATH -->|"start --json/--plain, spec, review, init --yes"| ST_HEADLESS_CONFIG{"Config jest i brak --reconfigure?"}
  ST_HEADLESS_CONFIG -->|"tak"| SKIP["nic nie zapisuj"]
  ST_HEADLESS_CONFIG -->|"nie"| DET["detectAll: wszystkie narzędzia CLI i dostawcy"]
  DET --> ST_DEFAULT_CREW{"Jest gotowe narzędzie na PLAN i coś na BUILD?"}
  ST_DEFAULT_CREW -->|"tak"| CREW["załoga wykryta + flagi CLI"]
  ST_DEFAULT_CREW -->|"nie: null"| OVR["domyślny config + flagi CLI"]
  CREW --> ST_CREW_AVAILABLE{"Każdy seat dostępny?"}
  OVR --> ST_CREW_AVAILABLE
  ST_CREW_AVAILABLE -->|"nie, brak wykrytej załogi"| E1["No config found and no ready crew is available.<br/>Run splitbrief init ... exit 1"]
  ST_CREW_AVAILABLE -->|"nie, seat niedostępny"| E2["X is unavailable ... exit 1"]
  ST_CREW_AVAILABLE -->|"tak"| ST_CONFIG_SAVE{"Zapis atomowy udany?"}
  ST_CONFIG_SAVE -->|"conflict lub niepewny"| E3["Config changed during setup. Retry<br/>exit 1"]
  ST_CONFIG_SAVE -->|"saved"| OK1["No config found. Saved a ready crew<br/>+ ewentualnie reguła .gitignore"]
  SUP --> ST_SETUP_STEP{"Wykrywanie narzędzi?"}
  ST_SETUP_STEP -->|"w toku"| WAIT["Choose your crew after the tool check<br/>esc quit"]
  ST_SETUP_STEP -->|"failed"| FAILD["Your tools could not be checked.<br/>r retry, s settings, esc quit"]
  ST_SETUP_STEP -->|"fresh"| ST_SETUP_INITIAL_CREW{"Wykryta załoga domyślna?"}
  ST_SETUP_INITIAL_CREW -->|"tak"| SETC["configStore.setInitialCrew"]
  ST_SETUP_INITIAL_CREW -->|"nie"| KEEPD["zostaje config domyślny"]
  SETC --> LIST["Set up your crew: Ready-made crews, Crew, Continue"]
  KEEPD --> LIST
  LIST --> ST_PRESET_READY{"Wybrany preset ma niegotowe narzędzia?"}
  ST_PRESET_READY -->|"tak"| LIST
  ST_PRESET_READY -->|"nie lub wiersz seatu"| PICK["preset stosowany albo picker seatu"]
  PICK --> LIST
  LIST --> ST_SETUP_CONTINUE{"Continue: każdy seat dostępny?"}
  ST_SETUP_CONTINUE -->|"nie"| MSG["Choose a ready tool and model for each unavailable seat."]
  ST_SETUP_CONTINUE -->|"tak"| SAVE["configStore.save"]
  SAVE --> ST_SETUP_ONCOMPLETE{"Start miał feature?"}
  ST_SETUP_ONCOMPLETE -->|"tak"| PREP["preparation: Checking tools, potem workflow"]
  ST_SETUP_ONCOMPLETE -->|"nie"| HOME["home + Saved your crew ..."]`
    },
    {
      id: 'startup-headless',
      title: 'Tryb headless (--json, --plain): od startu do kodu wyjścia',
      caption: 'Headless nie ma ekranu ani pytań. Plan jest zatwierdzany bez człowieka, a każda sytuacja, która w TUI czeka na człowieka, kończy proces kodem 1 i linią splitbrief continue.',
      mermaid: `flowchart TD
  H0["runHeadlessStart"] --> SW["setupWorkflow: repo git, reapOrphanRunners"]
  SW --> ST_NEEDS_SETUP{"Brak config.yaml?"}
  ST_NEEDS_SETUP -->|"tak"| EHC["ensureHeadlessConfig: diagram pierwszego uruchomienia"]
  ST_NEEDS_SETUP -->|"nie"| ST_SKILLS{"--skills: każde id znalezione?"}
  EHC --> ST_SKILLS
  ST_SKILLS -->|"nie"| E2["Unknown skill: id<br/>exit 2"]
  ST_SKILLS -->|"tak lub brak flagi"| PREP["prepareStartExecution<br/>--json: rekord readiness_report"]
  PREP --> ST_PREP_OUTCOME{"Wynik przygotowania?"}
  ST_PREP_OUTCOME -->|"blocked"| E1["blokery na stderr<br/>Run readiness blocked ... exit 1"]
  ST_PREP_OUTCOME -->|"failed, aborted"| E1b["Error ... exit 1"]
  ST_PREP_OUTCOME -->|"prepared"| ST_SEAT_DOWN_SWITCH{"--on-seat-down switch bez fallback w configu?"}
  ST_SEAT_DOWN_SWITCH -->|"tak"| E3["needs a seat that declares fallback<br/>exit 2"]
  ST_SEAT_DOWN_SWITCH -->|"nie"| ST_HEADLESS_AUTO_SWAP{"Czeka automatyczna zamiana seatu?"}
  ST_HEADLESS_AUTO_SWAP -->|"tak i nie halt"| SWAP["applyOfferedSeatSwap"]
  SWAP -->|"halt dalej czeka"| RR["recovery_required<br/>exit 1"]
  SWAP -->|"zamieniono"| ST_HEADLESS_RESUME_PENDING
  ST_HEADLESS_AUTO_SWAP -->|"nie"| ST_HEADLESS_RESUME_PENDING{"Resume z czekającym recovery lub pytaniem?"}
  ST_HEADLESS_RESUME_PENDING -->|"tak"| RR
  ST_HEADLESS_RESUME_PENDING -->|"nie"| RUN["runWorkflow headless<br/>plan zatwierdzony bez człowieka"]
  RUN --> ST_HEADLESS_STOPPED{"Przyszedł SIGINT, SIGTERM lub SIGHUP?"}
  ST_HEADLESS_STOPPED -->|"tak"| STOP["Run id stopped. Continue with ...<br/>exit 130, 143, 129"]
  ST_HEADLESS_STOPPED -->|"nie"| ST_HEADLESS_LOOP{"Inny seat padł z automatyczną zamianą?"}
  ST_HEADLESS_LOOP -->|"tak i nie halt"| ST_HEADLESS_AUTO_SWAP
  ST_HEADLESS_LOOP -->|"nie"| ST_HEADLESS_FINAL{"Stan końcowy runu?"}
  ST_HEADLESS_FINAL -->|"pytanie plannera"| IR["input_required<br/>exit 1"]
  ST_HEADLESS_FINAL -->|"recovery"| RR
  ST_HEADLESS_FINAL -->|"ready-to-apply"| RA["ready_to_apply + linie Apply/Discard<br/>exit 0"]
  ST_HEADLESS_FINAL -->|"closed complete"| DONE["exit 0"]
  ST_HEADLESS_FINAL -->|"review failed"| FR["final_review_failed<br/>exit 1"]
  ST_HEADLESS_FINAL -->|"run failed"| FE["error: Session failed<br/>exit 1"]
  ST_HEADLESS_FINAL -->|"review nieskończony lub run przerwany"| FI["final_review_incomplete lub error<br/>exit 1"]`
    },
    {
      id: 'startup-continue-resume',
      title: 'resume i continue: wznowienie zapisanego runu',
      caption: 'resume bierze tylko run ze wskaźnika active. continue bierze dowolny run po id, nazwie lub numerze i może najpierw wykonać --action. Obie drogi kończą w resumeSavedSession.',
      mermaid: `flowchart TD
  R0["splitbrief resume"] --> ST_RESUME_ACTIVE{"Wskaźnik active i żywotność procesu?"}
  ST_RESUME_ACTIVE -->|"brak active"| RE1["no active session to resume. exit 1"]
  ST_RESUME_ACTIVE -->|"żyje lub proces wisi"| RE2["is running, stop it ... exit 1"]
  ST_RESUME_ACTIVE -->|"martwy"| RST["loadRunRecord: invalid lub missing daje exit 1"]
  RST --> HPEND["headless: czekające recovery daje exit 1"]
  HPEND --> RSS["resumeSavedSession"]
  C0["splitbrief continue id"] --> ST_CONTINUE_TARGET{"Który run?"}
  ST_CONTINUE_TARGET -->|"numer: alias"| T1["n-ty od najnowszego"]
  ST_CONTINUE_TARGET -->|"nazwa"| T2["folder sesji musi istnieć"]
  ST_CONTINUE_TARGET -->|"brak id"| T3["wskaźnik active"]
  ST_CONTINUE_TARGET -->|"brak id i brak active"| CE0["no session to continue. exit 1"]
  T1 --> ST_CONTINUE_STATE{"Stan zapisanego runu?"}
  T2 --> ST_CONTINUE_STATE
  T3 --> ST_CONTINUE_STATE
  ST_CONTINUE_STATE -->|"invalid, missing, running, closed"| CE1["exit 1"]
  ST_CONTINUE_STATE -->|"open lub ready-to-apply"| ST_CONTINUE_ACTION{"--action?"}
  ST_CONTINUE_ACTION -->|"end-run"| END1["zamknij run: Run id closed. exit 0"]
  ST_CONTINUE_ACTION -->|"apply, discard"| SET["settleReadyRun, gdy nie ready to exit 1"]
  ST_CONTINUE_ACTION -->|"restore"| RESTO["odpowiedz recovery + Apply at rest"]
  ST_CONTINUE_ACTION -->|"skip, retry, switch-seat"| ACT["TTY lub headless? potem applyRecoveryAction"]
  ST_CONTINUE_ACTION -->|"brak"| NOACT["TTY lub headless?"]
  ACT --> RSS
  NOACT --> RSS
  SET -->|"review po Apply"| RSS
  RSS --> ST_RESUMABLE{"Run closed lub ready-to-apply?"}
  ST_RESUMABLE -->|"closed"| RE3["is closed; nothing to resume. exit 1"]
  ST_RESUMABLE -->|"ready-to-apply"| RE4["is ready to apply + linie Apply/Discard. exit 1"]
  ST_RESUMABLE -->|"open"| ST_RESUME_MODE{"--json lub --plain?"}
  ST_RESUME_MODE -->|"tak"| HL["prepareExecution resume, potem runHeadless"]
  ST_RESUME_MODE -->|"nie"| TUI["setupWorkflow, initStores z pytaniem o hooki,<br/>prepareExecution, hydrateRun, ekran workflow"]`
    },
    {
      id: 'startup-small-commands',
      title: 'doctor, status, init, spec, review: każda komenda osobno',
      caption: 'Małe przepływy. doctor i status nic nie zmieniają (doctor --probe-seat robi jedno płatne wywołanie). spec i review mogą zapisać config przy pierwszym uruchomieniu.',
      mermaid: `flowchart TD
  D0["doctor"] --> ST_DOCTOR_MODE{"--probe-seat podane?"}
  ST_DOCTOR_MODE -->|"tak"| PROBE["jedno płatne wywołanie: Seat probe X: klasa<br/>exit 0, zły seat lub nie-cli: exit 1"]
  ST_DOCTOR_MODE -->|"nie"| DREP["collectReadiness + detekcja CLI + preflight<br/>headless: replay dopuszczenia"]
  DREP --> ST_DOCTOR_EXIT{"Status blocked?"}
  ST_DOCTOR_EXIT -->|"tak"| DX1["raport, exit 1 bez linii Error"]
  ST_DOCTOR_EXIT -->|"nie"| DX0["raport, exit 0"]
  S0["status"] --> ST_STATUS_ACTIVE{"Active i state.json?"}
  ST_STATUS_ACTIVE -->|"nie"| SX["No active workflow. exit 0"]
  ST_STATUS_ACTIVE -->|"tak"| SY["Feature, Status, Task, seaty<br/>exit 0"]
  I0["init"] --> ST_INIT_EXISTS{"Config jest i brak --reconfigure?"}
  ST_INIT_EXISTS -->|"tak"| IX["Config already exists. exit 0"]
  ST_INIT_EXISTS -->|"nie"| ST_INIT_YES{"--yes?"}
  ST_INIT_YES -->|"tak"| IY["ensureHeadlessConfig, potem Run splitbrief doctor ..."]
  ST_INIT_YES -->|"nie"| IT["TTY? initStores, ekran Setup, potem home"]
  P0["spec feature"] --> PG["git, ensureHeadlessConfig, clear stale,<br/>config, hook trust, prepareExecution spec"]
  PG --> ST_SPEC_OUTCOME{"Wynik sesji planowania?"}
  ST_SPEC_OUTCOME -->|"plan"| PW["plan.json, plan.md, tasks.md<br/>Planning complete. exit 0"]
  ST_SPEC_OUTCOME -->|"protokół, 3. runda pytań, checks-failed"| PF["rollback sesji, exit 1"]
  V0["review"] --> VG["git, ensureHeadlessConfig, diff"]
  VG --> ST_REVIEW_DIFF{"Diff pusty?"}
  ST_REVIEW_DIFF -->|"tak"| VN["nothing to review. exit 0"]
  ST_REVIEW_DIFF -->|"nie"| VR["prepareReviewExecution, jedno wywołanie<br/>review.json i review.md, exit 0 przy każdym werdykcie"]`
    }
  ],
  decisions: [
    {
      id: 'ST_NODE_VERSION',
      title: 'Strażnik wersji Node',
      question: 'Czy proces działa na Node 22 lub nowszym?',
      where: 'src/cli/node-guard.ts:11',
      inputs: ['process.versions.node'],
      branches: [
        { if: 'major nie da się odczytać (NaN)', then: 'przepuść: nieznany runtime (shim, fork) może działać' },
        { if: 'major >= 22', then: 'przepuść' },
        { if: 'major < 22', then: 'CliError: `splitbrief requires Node.js 22 or newer; this process is Node.js <v>.` exit 1' }
      ],
      default: 'Brak innej drogi.',
      notes: 'Działa przed parsowaniem argumentów (`src/cli.ts:46`). package.json deklaruje `engines.node: ^22.0.0 || ^24.0.0`, ale strażnik nie odrzuca Node 23 ani 25.'
    },
    {
      id: 'ST_RETIRED_FLAG',
      title: 'Usunięte flagi',
      question: 'Czy argv zawiera usuniętą flagę `--mode`, `--approve` lub `--yolo`?',
      where: 'src/cli/unknown-command.ts:91',
      inputs: ['argv', 'lista flag przyjmujących wartość'],
      branches: [
        { if: 'flaga z RETIRED_FLAGS (także w formie `--mode=x`)', then: 'CliError `--mode was removed: every run plans in one session` (lub inny zamiennik), exit 1' },
        { if: 'flaga jest wartością innej flagi (np. `--planner-args --mode`)', then: 'pomiń: trafia do narzędzia plannera' },
        { if: 'po `--`', then: 'koniec skanowania' }
      ],
      default: 'Przejdź do sprawdzenia usuniętych komend.'
    },
    {
      id: 'ST_RETIRED_COMMAND',
      title: 'Usunięte komendy',
      question: 'Czy pierwszy operand to usunięta komenda (attach, detach, ps, last, mcp, explain, handoff, export, stats, snapshot, worktree, approval)?',
      where: 'src/cli/unknown-command.ts:74',
      inputs: ['pierwszy operand bez flag'],
      branches: [
        { if: 'operand jest w RETIRED_COMMANDS', then: 'CliError `unknown command \'ps\' — ...` + `If \'ps\' is the feature you meant, run: splitbrief start "ps"`, exit 1' },
        { if: 'operand to zarejestrowana komenda', then: 'przepuść' }
      ],
      default: 'Przejdź do sprawdzenia literówek.',
      notes: 'Bez tej tabeli `splitbrief attach <id>` stałby się opisem feature i kupił wywołanie plannera.'
    },
    {
      id: 'ST_MISTYPED_COMMAND',
      title: 'Literówka w nazwie komendy',
      question: 'Czy jedyny operand bez spacji jest bliski nazwie komendy?',
      where: 'src/cli/unknown-command.ts:53',
      inputs: ['operandy', 'nazwy komend'],
      branches: [
        { if: 'więcej niż jeden operand, operand ze spacją, zaczyna się od @, albo to nazwa komendy', then: 'przepuść (np. `splitbrief "fix the typo"`)' },
        { if: 'odległość edycyjna ≤ 1 dla nazwy ≤ 4 znaków, ≤ 2 dla dłuższej (transpozycja = 1)', then: 'CliError `unknown command \'doctro\' — did you mean \'doctor\'?` + linia ucieczki `splitbrief start "doctro"`, exit 1' }
      ],
      default: 'Brak bliskiej komendy: commander traktuje operand jako feature komendy `start`.'
    },
    {
      id: 'ST_OUTPUT_MODE',
      title: '--json i --plain razem',
      question: 'Czy podano obie flagi trybu headless?',
      where: 'src/cli/options.ts:352',
      inputs: ['opts.json', 'opts.plain'],
      branches: [
        { if: 'obie true', then: 'CliError `--plain and --json cannot be combined; choose one output mode.`, exit 2' }
      ],
      default: 'Przepuść.',
      notes: 'Hook preAction komend z addWorkflowOptions: start, resume, continue.'
    },
    {
      id: 'ST_COMMAND',
      title: 'Wybór komendy przez commander',
      question: 'Którą z ośmiu komend uruchomić?',
      where: 'src/cli.ts:36',
      inputs: ['argv'],
      branches: [
        { if: 'brak nazwy komendy lub `start`', then: 'start (isDefault: true)', next: 'ST_START_ARGS' },
        { if: '`spec <feature>`', then: 'tylko planowanie', next: 'ST_SPEC_OUTCOME' },
        { if: '`init`', then: 'Setup lub --yes', next: 'ST_INIT_EXISTS' },
        { if: '`status`', then: 'odczyt aktywnego runu', next: 'ST_STATUS_ACTIVE' },
        { if: '`resume`', then: 'ostatni run', next: 'ST_RESUME_ACTIVE' },
        { if: '`continue [id]`', then: 'run po id', next: 'ST_CONTINUE_TARGET' },
        { if: '`doctor`', then: 'raport gotowości', next: 'ST_DOCTOR_MODE' },
        { if: '`review`', then: 'jedno wywołanie reviewera', next: 'ST_REVIEW_DIFF' }
      ],
      default: 'Nieznana opcja lub zła wartość opcji: commander wypisuje błąd i kończy (parsery zgłaszają InvalidArgumentError). Wyjątki inne niż InvalidArgumentError (np. zła `--action`) idą do main().catch z kodem z CliError.',
      notes: 'Każdy wyjątek trafia do `main().catch` (`src/cli.ts:55`): `Error: <komunikat>` na stderr i `process.exit(CliError.exitCode ?? 1)`.'
    },
    {
      id: 'ST_START_ARGS',
      title: 'Walidacja argumentów start',
      question: 'Czy opis feature i pliki mają poprawny kształt?',
      where: 'src/cli/commands/start/register.ts:52',
      inputs: ['feature', 'files', 'tryb headless'],
      branches: [
        { if: 'brak feature, ale są pliki', then: 'CliError `Cannot start: the feature description is empty...`, exit 2' },
        { if: '`--json`/`--plain` bez feature', then: 'CliError `--json requires a feature argument`, exit 1' },
        { if: 'feature zaczyna się od `@` (i ma więcej niż 1 znak)', then: 'CliError `... is a file reference, not a feature description`, exit 2' }
      ],
      default: 'Przejdź do kanonizacji katalogu projektu.',
      next: 'ST_PROJECT_ROOT'
    },
    {
      id: 'ST_PROJECT_ROOT',
      title: 'Kanonizacja katalogu projektu',
      question: 'Czy podany katalog leży wewnątrz repo git?',
      where: 'src/cli/setup.ts:34',
      inputs: ['--project lub cwd', 'git rev-parse --show-toplevel'],
      branches: [
        { if: 'nie ma repo (toplevel null)', then: 'projectDir = podana ścieżka (później bloker / błąd git)' },
        { if: 'ścieżka to już toplevel (po realpath)', then: 'projectDir = toplevel' },
        { if: 'podkatalog i podano --project', then: 'ostrzeżenie `--project X is inside git repository Y; using repository root.`, projectDir = toplevel' },
        { if: 'podkatalog bez --project', then: 'projectDir = toplevel bez komunikatu' }
      ],
      default: 'Każda komenda przechodzi przez tę funkcję.'
    },
    {
      id: 'ST_AT_FILES',
      title: 'Argumenty @plik',
      question: 'Czy każdy argument `@ścieżka` da się wczytać?',
      where: 'src/cli/commands/start/register.ts:75',
      inputs: ['files', 'resolveInputFile'],
      branches: [
        { if: 'któryś plik odrzucony', then: 'CliError `Cannot start: SPLITBRIEF refused these @file inputs.` z listą powodów, exit 2; nic nie zostaje dołączone' },
        { if: 'obraz', then: 'attachmentsStore + attachedInputs (image)' },
        { if: 'tekst', then: 'blok w plannerContext + attachedInputs (text)' },
        { if: 'argument bez @', then: 'dopisany do opisu feature' }
      ],
      default: 'Brak plików: opis bez zmian.'
    },
    {
      id: 'ST_HEADLESS_MODE',
      title: 'TUI czy headless',
      question: 'Czy start ma działać bez ekranu?',
      where: 'src/cli/commands/start/register.ts:86',
      inputs: ['--json', '--plain', 'feature'],
      branches: [
        { if: '`--json`', then: 'headless, NDJSON na stdout', next: 'ST_SKILLS' },
        { if: '`--plain`', then: 'headless, jedna linia na fazę/zadanie/review', next: 'ST_SKILLS' },
        { if: 'brak obu', then: 'TUI; diagnostyka wstrzymana do montażu ekranu (withHeldDiagnostics)', next: 'ST_TTY' }
      ],
      default: 'TUI.',
      notes: 'W TUI `--skills`, `--on-seat-down` i `--allow-unverified-auth` nie działają przy start (auth nieznany jest ujawniany, nie odrzucany).'
    },
    {
      id: 'ST_TTY',
      title: 'Wymóg terminala',
      question: 'Czy stdin to TTY?',
      where: 'src/cli/setup.ts:64',
      inputs: ['process.stdin.isTTY'],
      branches: [
        { if: 'nie', then: 'CliError `interactive mode needs a TTY — use --json or --plain`, exit 1' },
        { if: 'tak', then: 'przejdź do setupWorkflow' }
      ],
      default: 'Ten sam strażnik ma init (z podpowiedzią `use --yes`), resume i continue bez trybu headless.',
      notes: 'Zmienna CI nie blokuje TUI; wyłącza tylko fullscreen i mysz (ST_RENDER_FLAGS).'
    },
    {
      id: 'ST_GIT_REPO',
      title: 'Repo git wymagane',
      question: 'Czy projectDir to repo git?',
      where: 'src/cli/setup.ts:78',
      inputs: ['git'],
      branches: [
        { if: 'nie', then: 'CliError `not a git repository. Run git init first.`, exit 1' },
        { if: 'tak', then: 'reapOrphanRunners (sprząta osierocone procesy narzędzi → zobacz lifecycle), potem flagi ekranu' }
      ],
      default: 'Używane przez start (obie drogi), spec i review. init, status, doctor tego nie wołają (doctor zgłasza bloker `repo.not-git`).'
    },
    {
      id: 'ST_RENDER_FLAGS',
      title: 'Fullscreen, mysz, hover',
      question: 'Jak rysować TUI?',
      where: 'src/cli/setup.ts:163',
      inputs: ['stdout.isTTY', 'env CI', '--no-fullscreen', '--no-mouse', '--hover'],
      branches: [
        { if: 'stdout to TTY i brak CI i brak --no-fullscreen', then: 'useFullscreen = true' },
        { if: 'fullscreen i brak --no-mouse', then: 'useMouse = true' },
        { if: 'mysz i --hover', then: 'useHover = true' }
      ],
      default: 'Bez TTY lub z CI: zwykły ekran bez alternate screen.',
      notes: 'init w TUI zawsze woła renderApp z fullscreen: true (`src/cli/commands/init.ts:58`).'
    },
    {
      id: 'ST_NEEDS_SETUP',
      title: 'Brak configu: potrzebny Setup',
      question: 'Czy istnieje `.splitbrief/config.yaml`?',
      where: 'src/cli/setup.ts:167',
      inputs: ['existsSync(configPath)'],
      branches: [
        { if: 'nie, TUI', then: 'needsSetup: ekran Setup (nawet gdy podano flagi seatów)', next: 'ST_LIVE_SESSION_TUI' },
        { if: 'nie, headless', then: 'ensureHeadlessConfig', next: 'ST_HEADLESS_CONFIG' },
        { if: 'tak', then: 'zwykła droga' }
      ],
      default: 'Config istnieje.'
    },
    {
      id: 'ST_HOOK_TRUST',
      title: 'Zaufanie do hooków (pytanie w terminalu)',
      question: 'Czy hooki z configu wolno uruchamiać na tej maszynie?',
      where: 'src/cli/hook-trust-prompt.ts:44',
      inputs: ['config.hooks', '~/.splitbrief/trust/hooks.json', '--allow-hooks', 'stdin.isTTY', 'odpowiedź y/N'],
      branches: [
        { if: 'brak bloku hooks', then: 'przepuść' },
        { if: 'cel hooka to symlink (nie-kwalifikowalny)', then: 'CliError `hook target is not trust-eligible: ...`, exit 1; ani receipt, ani --allow-hooks nie pomaga' },
        { if: 'receipt z pasującym digestem (ST_HOOK_RECEIPT)', then: 'przepuść', next: 'ST_HOOK_RECEIPT' },
        { if: '`--allow-hooks`', then: 'wypisz ujawnienie na stderr, zapisz receipt, przepuść' },
        { if: 'brak TTY', then: 'CliError `Hook config is not trusted and no TTY available. Re-run with --allow-hooks...`, exit 1' },
        { if: 'pytanie `Trust these hooks for this project? [y/N]`: y lub yes', then: 'zapisz receipt, przepuść' },
        { if: 'inna odpowiedź, Enter lub EOF', then: 'CliError `Refusing to run with untrusted hooks. Edit .splitbrief/config.yaml or re-run and answer y.`, exit 1' }
      ],
      default: 'Brak.',
      notes: 'Wołane w bootstrapStoresHooks (`src/cli/bootstrap/init.ts:22`) i w `spec` (`src/cli/commands/spec.ts:123`). Droga headless start/resume/continue tego nie woła (zobacz gotchas). Pytanie pokazuje komendę, rozwiązaną ścieżkę, argumenty i on_failure; nigdy `name:` z configu.'
    },
    {
      id: 'ST_HOOK_RECEIPT',
      title: 'Receipt zaufania hooków',
      question: 'Czy w magazynie zaufania jest ważny receipt dla tej kopii repo i tego configu?',
      where: 'src/core/hooks/trust.ts:55',
      inputs: ['realpath projektu (sha256)', 'digest configu hooków i plików skryptów', 'prawa pliku hooks.json'],
      branches: [
        { if: 'cel hooka nie-kwalifikowalny', then: 'false' },
        { if: 'realpath się nie rozwiązuje', then: 'false (fail closed)' },
        { if: 'plik magazynu symlink, prawa grupy/innych, > 256 KiB, zły JSON', then: 'invalid: false' },
        { if: 'receipt dla projektu z tym samym digestem', then: 'true' }
      ],
      default: 'false: pytanie zostanie zadane.',
      notes: 'Receipt jest per kopia repo i per maszyna (`~/.splitbrief/trust/`); repo nie może dostarczyć własnego. Ta sama funkcja broni wykonania hooka w trakcie runu (`src/engine/hooks/dispatch.ts:28`).'
    },
    {
      id: 'ST_INTERACTIVE_ROUTE',
      title: 'Na który ekran trafia TUI',
      question: 'Setup, home z przygotowaniem czy samo home?',
      where: 'src/cli/commands/start/interactive.ts:41',
      inputs: ['needsSetup', 'feature'],
      branches: [
        { if: 'needsSetup', then: 'router: screen setup, onComplete = feature ? workflow : home; feature, plannerContext, załączniki i allowRepoRunners czekają w routerze', next: 'ST_LIVE_SESSION_TUI' },
        { if: 'feature', then: 'montuj home i od razu `preparationStore.submit` (stage `Checking tools`)', next: 'ST_PREP_SUPERSEDE' },
        { if: 'brak feature', then: 'home', next: 'ST_LIVE_SESSION_TUI' }
      ],
      default: 'home.'
    },
    {
      id: 'ST_LIVE_SESSION_TUI',
      title: 'Żywy run przy otwieraniu TUI bez startu',
      question: 'Czy inny run w tej kopii repo jeszcze żyje?',
      where: 'src/cli/commands/start/readiness.ts:192',
      inputs: ['.splitbrief/active', 'lockfile/PID sesji'],
      branches: [
        { if: 'żyje', then: 'CliError `session \'<id>\' is still active.` + `Stop it, then run splitbrief continue <id> — or delete .splitbrief/active`, exit 1' },
        { if: 'nie żyje albo brak', then: 'montuj TUI; wskaźnik NIE jest usuwany (resume go potrzebuje)' }
      ],
      default: 'Montuj TUI.',
      notes: 'Start z feature nie używa tego strażnika: żywy run staje się blokerem `repo.active-session-live` (ST_ACTIVE_SESSION).'
    },
    {
      id: 'ST_PREP_SUPERSEDE',
      title: 'Nowsza próba wypiera starszą',
      question: 'Czy wynik należy do bieżącej próby przygotowania?',
      where: 'src/stores/navigation/preparation.ts:77',
      inputs: ['numer próby', 'bieżące checking'],
      branches: [
        { if: 'nowszy submit lub anulowanie (Esc) zastąpił tę próbę', then: 'prepared: rollback własnej sesji/receiptu; reszta ignorowana' },
        { if: 'submit z tym samym kluczem, gdy trwa sprawdzanie', then: 'dołącz do trwającej próby' },
        { if: 'bieżąca', then: 'rozstrzygnij wynik', next: 'ST_PREP_OUTCOME' }
      ],
      default: 'Bieżąca próba rozstrzyga.',
      notes: 'Start z CLI kończy proces tylko, gdy blocked/failed dotyczy jego własnej próby (`src/cli/commands/start/interactive.ts:102`).'
    },
    {
      id: 'ST_PREP_OUTCOME',
      title: 'Wynik przygotowania wykonania',
      question: 'prepared, blocked, failed czy aborted?',
      where: 'src/cli/commands/start/readiness.ts:206',
      inputs: ['PreparationOutcome', 'tryb stdout: prose lub structured'],
      branches: [
        { if: 'prepared', then: 'TUI: navigate workflow z execution local; headless: runHeadless' },
        { if: 'blocked', then: 'raport blokerów (TUI: stdout po zamknięciu Ink; headless: stderr), potem CliError `Run readiness blocked: N blockers. Resolve the blockers above (run splitbrief doctor for details).`, exit 1' },
        { if: 'failed', then: 'CliError z komunikatem błędu, exit 1' },
        { if: 'aborted', then: 'CliError `Runner preparation was cancelled.`, exit 1 (TUI: zwykle nic, bo stan wraca do idle)' }
      ],
      default: 'Brak.',
      notes: 'W TUI przy starcie z ekranu home/Setup blokada pokazuje panel `Tool preparation · Blocked` z klawiszami r retry, esc back, s settings (`src/features/start-preparation/panel.tsx:344`).'
    },
    {
      id: 'ST_CLEAR_STALE',
      title: 'Czyszczenie martwego wskaźnika active',
      question: 'Czy `.splitbrief/active` wskazuje żywy run?',
      where: 'src/core/sessions/guards.ts:11',
      inputs: ['.splitbrief/active', 'isSessionLive'],
      branches: [
        { if: 'brak wskaźnika', then: 'nic' },
        { if: 'run żyje', then: 'zostaw; readiness zgłosi bloker (start) — `clearStaleSessionForCli` połyka ten błąd', next: 'ST_ACTIVE_SESSION' },
        { if: 'run nie żyje', then: 'usuń wskaźnik i kontynuuj' }
      ],
      default: 'Kontynuuj.',
      notes: 'Wołane przed nowym runem: start (`src/cli/commands/start/readiness.ts:285`) i spec. prepareNewSession sprawdza to jeszcze raz pod blokadą.'
    },
    {
      id: 'ST_CONFIG_CHECK',
      title: 'Sekcja Config raportu gotowości',
      question: 'Czy config istnieje i się wczytuje?',
      where: 'src/core/readiness/checks/config.ts:15',
      inputs: ['stan wczytania configu'],
      branches: [
        { if: 'missing', then: 'bloker `config.missing`: `No .splitbrief/config.yaml found.`, fix `Run splitbrief init`' },
        { if: 'invalid', then: 'bloker `config.invalid`: `Config could not be loaded.` + szczegóły, fix `splitbrief init --reconfigure`' },
        { if: 'loaded', then: 'ok + jedno ostrzeżenie `config.warning` na każdą unikalną uwagę (prawa pliku, wycofane klucze, {prompt} w args)' }
      ],
      default: 'Bez configu sekcje workflow, runners, context i validation nie powstają.',
      notes: 'W start config jest już wczytany przed raportem, więc missing/invalid widzi praktycznie tylko doctor.'
    },
    {
      id: 'ST_REPO_CHECK',
      title: 'Sekcja Repository: git, commity, operacje git',
      question: 'Czy repo nadaje się do runu?',
      where: 'src/core/readiness/checks/repo.ts:35',
      inputs: ['isGitRepo', 'hasCommits', 'getInProgressGitOp', 'getCurrentBranch'],
      branches: [
        { if: 'nie repo git', then: 'bloker `repo.not-git`' },
        { if: 'brak commitów', then: 'bloker `repo.no-commits`: zrób pierwszy commit' },
        { if: 'merge/rebase/cherry-pick/revert/bisect w toku', then: 'bloker `repo.in-progress-git-op` z komendą abort' },
        { if: 'detached HEAD', then: 'ostrzeżenie `repo.detached-head`' }
      ],
      default: 'ok `repo.git`.'
    },
    {
      id: 'ST_ACTIVE_SESSION',
      title: 'Inny run aktywny',
      question: 'Czy wskaźnik active wskazuje inny, żywy run?',
      where: 'src/core/readiness/checks/repo.ts:94',
      inputs: ['readActive', 'isSessionLive', 'sesja wznawiana'],
      branches: [
        { if: 'wskaźnik wskazuje wznawiany run', then: 'pomiń (resume nie blokuje sam siebie)' },
        { if: 'inny run żyje', then: 'bloker `repo.active-session-live` z fix stillActiveFix' },
        { if: 'inny run nie żyje', then: 'info `repo.active-session-stale`' }
      ],
      default: 'Brak wskaźnika: brak wpisu.',
      notes: 'W `review` ten bloker jest obniżany do info (exemptLiveSessionBlocker), bo review nie tworzy sesji.'
    },
    {
      id: 'ST_DIRTY_WORKTREE',
      title: 'Brudne drzewo robocze',
      question: 'Czy użytkownik ma niezatwierdzone lub nieśledzone pliki?',
      where: 'src/core/readiness/checks/repo.ts:109',
      inputs: ['git status bez plików .splitbrief/, .trees/ i własnych linii .gitignore'],
      branches: [
        { if: 'są zmiany, izolacja none', then: 'ostrzeżenie `repo.dirty-worktree`: run edytuje tę kopię; revert zapisuje zastąpione pliki w reverted/' },
        { if: 'są zmiany, worktree/staged-copy', then: 'ostrzeżenie: sprawdź, czy lokalne edycje nie nachodzą na zmianę' }
      ],
      default: 'Brak wpisu.',
      notes: 'Nigdy nie blokuje. Pliki zmienione przed runem są pracą użytkownika (resolveRunUniverse → zobacz lifecycle).'
    },
    {
      id: 'ST_PLAN_APPROVAL',
      title: 'Info o zatwierdzaniu planu',
      question: 'Kto zatwierdzi plan?',
      where: 'src/core/readiness/checks/plan-approval.ts:21',
      inputs: ['workflow.approve', 'interaction'],
      branches: [
        { if: 'approve plan, TUI', then: 'info `Plan approval: you approve the plan in the TUI.`' },
        { if: 'approve plan, headless', then: 'info + `Headless runs approve the plan automatically because there is no approval prompt.`' },
        { if: 'approve none', then: 'info `Plan approval: automatic.`' }
      ],
      default: 'Zawsze też info `workflow.retries`: BUILD ma 1 ponowienie po nieudanym checku.'
    },
    {
      id: 'ST_CONTEXT_LENGTH',
      title: 'Długość kontekstu seatów',
      question: 'Czy contextLength PLAN i domyślnego BUILD jest wystarczający?',
      where: 'src/core/readiness/checks/context.ts:49',
      inputs: ['planner.contextLength', 'implementer.contextLength lub profil'],
      branches: [
        { if: 'nieustawione', then: 'info: rozmiar dobierany automatycznie' },
        { if: '< 32000', then: 'ostrzeżenie `context.<rola>.tight` z fix (Settings > Tuning)' },
        { if: '>= 32000', then: 'ok' }
      ],
      default: 'Nigdy nie blokuje.'
    },
    {
      id: 'ST_END_CHECKS',
      title: 'Sekcja Validation',
      question: 'Czy sprawdzenia przed review są włączone i czy jest komenda testów?',
      where: 'src/core/readiness/checks/validation.ts:58',
      inputs: ['validation.end_checks', 'validation.test_command', 'package.json scripts', 'stos'],
      branches: [
        { if: 'end_checks false', then: 'ostrzeżenie `validation.end-checks-off`' },
        { if: 'brak komendy testów', then: 'info: `No test command found.` (nie blokuje)' },
        { if: 'komenda `npm run x`, a skryptu x nie ma', then: 'ostrzeżenie `validation.test-script-missing`' },
        { if: 'package.json niepoprawny', then: 'ostrzeżenie `validation.package-json-invalid`' }
      ],
      default: 'info `validation.configured`. Readiness nie uruchamia żadnej komendy.'
    },
    {
      id: 'ST_ISOLATION_STACK',
      title: 'Stos, którego worktree nie obsłuży',
      question: 'Czy projekt rozwiązuje zależności do kopii roboczej, a izolacja nie jest wybrana jawnie?',
      where: 'src/core/readiness/checks/isolation.ts:25',
      inputs: ['workflow.isolation w pliku', 'package.json workspaces', 'pnpm-workspace.yaml', 'venv z editable install', 'go.work', 'Cargo [workspace] + target/'],
      branches: [
        { if: 'isolation: none', then: 'brak wpisów' },
        { if: 'wykryto stos, isolation nieustawione w pliku', then: 'BLOKER (np. `... Run in your checkout.`), fix: ustaw `workflow.isolation: none` lub `worktree`' },
        { if: 'wykryto stos, isolation worktree/staged-copy w pliku', then: 'ostrzeżenie' }
      ],
      default: 'Brak wykrytego stosu: brak wpisów.',
      notes: 'Liczy się klucz w pliku, nie wartość domyślna (domyślnie worktree, `src/core/config/accessors/values.ts:9`). Błąd samego sprawdzenia daje ostrzeżenie `isolation.check-failed`.'
    },
    {
      id: 'ST_SANDBOX',
      title: 'Sandbox Claude Code na Linuksie',
      question: 'Czy BUILD na claude-code znajdzie bwrap i socat?',
      where: 'src/core/readiness/checks/claude-sandbox.ts:61',
      inputs: ['platforma', 'profile BUILD z tool claude-code', 'PATH (tylko wpisy absolutne)'],
      branches: [
        { if: 'nie Linux albo brak profilu claude-code', then: 'brak wpisu' },
        { if: 'oba programy są', then: 'ok' },
        { if: 'brak, profil domyślny', then: 'BLOKER `runners.sandbox.claude-code` z fix apt-get install bubblewrap socat' },
        { if: 'brak, profil niedomyślny', then: 'ostrzeżenie' }
      ],
      default: 'Sprawdzane tylko, gdy run woła BUILD (nie dla spec ani review).'
    },
    {
      id: 'ST_READINESS_STATUS',
      title: 'Status raportu gotowości',
      question: 'blocked, ready-with-warnings czy ready?',
      where: 'src/core/readiness/status.ts:77',
      inputs: ['liczniki severity'],
      branches: [
        { if: 'blocker > 0', then: 'blocked; nextAction wg priorytetu fix-config, run-init, prepare-runner, clean-or-isolate-repo, raise-context' },
        { if: 'warning > 0', then: 'ready-with-warnings: start idzie dalej, ostrzeżenia pokazane pod prośbą' },
        { if: 'inaczej', then: 'ready' }
      ],
      default: 'ready.',
      notes: 'prepareExecution sprawdza status trzy razy: po sekcjach (`prepare-execution.ts:250`), po werdyktach seatów (`:291`) i po preflight argumentów (`:333`).'
    },
    {
      id: 'ST_CANDIDATES',
      title: 'Które seaty sprawdzić',
      question: 'Jakie seaty woła run o tym celu?',
      where: 'src/engine/runners/prepare-execution/runner-candidates.ts:81',
      inputs: ['purpose', 'config'],
      branches: [
        { if: 'review', then: 'tylko seat review (skonfigurowany reviewer albo planner)' },
        { if: 'spec', then: 'tylko PLAN' },
        { if: 'new-workflow lub resume', then: 'PLAN, każdy profil BUILD (nie tylko domyślny), REVIEW gdy jest blok reviewer' }
      ],
      default: 'Seaty zapasowe (fallback) nie są sprawdzane przy starcie → zobacz runners/recovery.'
    },
    {
      id: 'ST_RUNNER_KIND',
      title: 'Drabina dopuszczenia według rodzaju seatu',
      question: 'Jak dopuścić ten seat?',
      where: 'src/engine/runners/prepare-execution/evaluate-candidate.ts:606',
      inputs: ['runner.kind'],
      branches: [
        { if: 'cli', then: 'dowody narzędzia', next: 'ST_SESSION_AUTH_RETRY' },
        { if: 'api', then: 'klucz i endpoint', next: 'ST_API_CREDENTIALS' },
        { if: 'shell lub agent', then: 'zaufanie do komendy', next: 'ST_CUSTOM_RUNNER' }
      ],
      default: 'Brak innych rodzajów.'
    },
    {
      id: 'ST_SESSION_AUTH_RETRY',
      title: 'Drugi odczyt logowania na kanale session',
      question: 'Czy pierwsza odmowa logowania to zimny odczyt?',
      where: 'src/engine/runners/prepare-execution/evaluate-candidate.ts:296',
      inputs: ['werdykt bramki', 'kanał auth'],
      branches: [
        { if: 'odmowa authentication na kanale `session`', then: 'odczekaj READINESS_RETRY_DELAY_MS, odczytaj dowody ponownie, dodaj ostrzeżenie `readiness_probe_retried`' }
      ],
      default: 'Bez ponowienia.',
      next: 'ST_CLI_ADMISSION'
    },
    {
      id: 'ST_CLI_ADMISSION',
      title: 'Werdykt bramki CLI: zainstalowany, zaufany, zgodny, zalogowany',
      question: 'Czy narzędzie CLI może wystartować?',
      where: 'src/engine/runners/prepare-execution/evaluate-candidate.ts:340',
      inputs: ['RunnerEvidence: plik wykonywalny, wersja, auth, model'],
      branches: [
        { if: 'brak pliku', then: 'bloker `<Tool> is not installed.` (cause missing-binary)' },
        { if: 'auth missing/invalid', then: 'bloker `<Tool> is not signed in.` / `credentials are invalid.` z instrukcją logowania' },
        { if: 'auth timeout/offline/malformed/policy-denied', then: 'bloker z odpowiednim fix' },
        { if: 'wersja niezgodna lub niepotwierdzona', then: 'bloker `version is not compatible` / `could not be confirmed`' },
        { if: 'plik niezaufany, wyłączony, stare dowody, model nie potwierdzony', then: 'bloker z fix (często `splitbrief doctor`)' },
        { if: 'auth unknown', then: 'zależy od trybu', next: 'ST_UNVERIFIED_AUTH' },
        { if: 'jawny auth_channel nieobsługiwany na platformie', then: 'bloker: usuń auth_channel' },
        { if: 'admitted', then: 'gate z plikiem i wersją; model `auto` zamieniony na model hosta; ewentualne ostrzeżenie trasy bez poświadczeń' }
      ],
      default: 'Szczegóły dowodów i klasyfikacji → zobacz runners.',
      notes: 'Narzędzie bez zapisanych poświadczeń (np. opencode z dostawcą w swoim configu) jest dopuszczane, gdy jego lista modeli obsługuje trasę seatu.'
    },
    {
      id: 'ST_UNVERIFIED_AUTH',
      title: 'Logowanie, którego nie da się sprawdzić',
      question: 'Co zrobić, gdy auth = unknown?',
      where: 'src/core/discovery/runner-evidence.ts:253',
      inputs: ['interaction', 'unverifiedAuth', '--allow-unverified-auth'],
      branches: [
        { if: 'TUI (polityka disclosed)', then: 'dopuść; fakt nieweryfikowanego logowania zostaje w raporcie' },
        { if: 'headless z `--allow-unverified-auth`', then: 'dopuść' },
        { if: 'headless bez flagi', then: 'bloker `<Tool> sign-in status is unknown.`' }
      ],
      default: 'TUI zawsze ujawnia, nie blokuje (`src/cli/commands/start/readiness.ts:242`).'
    },
    {
      id: 'ST_API_CREDENTIALS',
      title: 'Seat API: klucz i endpoint',
      question: 'Czy dostawca API ma poświadczenia?',
      where: 'src/engine/runners/prepare-execution/evaluate-candidate.ts:420',
      inputs: ['provider', 'apiBase', 'apiKey (env)'],
      branches: [
        { if: 'dostawca zdalny bez klucza', then: 'bloker `Provider credentials are missing.`' },
        { if: 'getProvider rzuca (zły endpoint lub polityka)', then: 'bloker `Provider credentials or endpoint policy are invalid.`' },
        { if: 'lokalny (Ollama, LM Studio) lub klucz jest', then: 'dopuść' }
      ],
      default: 'Dostępność sieciowa dostawcy jest sprawdzana osobno przez probeRunnerAvailability → zobacz runners.'
    },
    {
      id: 'ST_CUSTOM_RUNNER',
      title: 'Seat shell/agent: zaufanie do komendy',
      question: 'Czy komenda z configu może się uruchomić?',
      where: 'src/engine/runners/prepare-execution/evaluate-candidate.ts:529',
      inputs: ['customCommands lub komenda inline', '--allow-repo-runners', 'receipt zaufania', 'TTY'],
      branches: [
        { if: 'komenda w repo bez `--allow-repo-runners`', then: 'bloker `Configured command is outside the current trust policy.` z fix dla tej komendy' },
        { if: 'TUI, brak receiptu', then: 'pytanie o ujawnienie (TUI: panel approval; terminal: promptCustomRunnerDisclosure)' },
        { if: 'brak pliku / nie wykonywalny / zmieniony od zaufania / niezaufany', then: 'bloker z odpowiednim powodem' },
        { if: 'receipt, potwierdzenie lub grant', then: 'dopuść; trustPersisted gdy zapisano receipt' }
      ],
      default: 'Szczegóły → zobacz runners.'
    },
    {
      id: 'ST_SEATS_BLOCKED',
      title: 'Jeden zablokowany seat blokuje start',
      question: 'Czy któryś seat dostał werdykt blocked?',
      where: 'src/engine/runners/prepare-execution/prepare-execution.ts:291',
      inputs: ['werdykty seatów'],
      branches: [
        { if: 'tak', then: 'outcome blocked z raportem' },
        { if: 'nie', then: 'zbierz gate-y, nazwij efektywne modele', next: 'ST_REVALIDATE' }
      ],
      default: 'Brak.'
    },
    {
      id: 'ST_REVALIDATE',
      title: 'Ponowne sprawdzenie pliku wykonywalnego',
      question: 'Czy plik CLI jest wciąż tym, który dopuszczono?',
      where: 'src/engine/runners/prepare-execution/prepare-execution.ts:306',
      inputs: ['gate.executable', 'aliasy pliku'],
      branches: [
        { if: 'zmienił się lub zniknął', then: 'bloker `CLI executable identity changed after admission.`' },
        { if: 'ten sam', then: 'dalej', next: 'ST_ARGV_PREFLIGHT' }
      ],
      default: 'Brak.'
    },
    {
      id: 'ST_ARGV_PREFLIGHT',
      title: 'Preflight argumentów CLI',
      question: 'Czy argumenty seatów pasują do zainstalowanej wersji narzędzia?',
      where: 'src/engine/runners/prepare-execution/prepare-execution.ts:333',
      inputs: ['config', 'wersje zainstalowane', 'wynik `--help`'],
      branches: [
        { if: 'bloker (np. sprzeczne argumenty)', then: 'outcome blocked' },
        { if: 'brak blokera', then: 'prepareNewSession: folder sesji z markerem własności, readiness.json, wskaźnik active → zobacz lifecycle' }
      ],
      default: 'Ten preflight uruchamia prawdziwy plik, dlatego czeka na drabinę zaufania. Dzieje się przed płatnym planowaniem.'
    },
    {
      id: 'ST_PLANNER_AVAILABLE',
      title: 'Ostatnie sprawdzenie przed planowaniem',
      question: 'Czy komenda plannera odpowiada?',
      where: 'src/engine/orchestrator/run/init.ts:398',
      inputs: ['planner.isAvailable() (`<cmd> --version`, `src/engine/availability.ts:50`)'],
      branches: [
        { if: 'nie, i brak czekającego recovery', then: 'error event `plannerUnavailableMessage`, initializeWorkflow zwraca ok: false; brak planowania' },
        { if: 'tak', then: 'utwórz seat BUILD i przejdź do runPlanningPhases → zobacz planning' }
      ],
      default: 'Przy wznowieniu z czekającym recovery sprawdzenie jest pomijane.'
    },
    {
      id: 'ST_CONFIG_EXISTS',
      title: 'Plik configu istnieje',
      question: 'Czy da się odczytać `.splitbrief/config.yaml`?',
      where: 'src/core/config/load/io.ts:147',
      inputs: ['readConfigDocument (O_NOFOLLOW)'],
      branches: [
        { if: 'brak pliku lub katalogu .splitbrief', then: 'createDefaultConfig: PLAN claude-code CLI, BUILD Ollama `qwen3-coder:30b`, end_checks true, approve plan, review end; bez błędu' },
        { if: 'plik to symlink', then: 'błąd symlinkRead' },
        { if: 'nie zwykły plik lub błąd odczytu', then: 'błąd unreadable' },
        { if: 'plik jest', then: 'parsuj', next: 'ST_YAML_PARSE' }
      ],
      default: 'Brak.',
      notes: 'Ostrzeżenie o prawach pliku (grupa/inni mogą zmieniać) to tylko uwaga `run chmod 600` (`io.ts:94`).'
    },
    {
      id: 'ST_YAML_PARSE',
      title: 'YAML i kształt dokumentu',
      question: 'Czy plik to poprawny YAML z obiektem na górze?',
      where: 'src/core/config/load/io.ts:105',
      inputs: ['rawYaml'],
      branches: [
        { if: 'błąd składni', then: 'configError.invalidYaml' },
        { if: 'nie obiekt (lista, skalar, pusty)', then: '`Configuration in .splitbrief/config.yaml must be a YAML object.`' },
        { if: 'obiekt', then: 'snake_case → camelCase', next: 'ST_CONFIG_VERSION' }
      ],
      default: 'Brak.'
    },
    {
      id: 'ST_CONFIG_VERSION',
      title: 'Tylko version: 3',
      question: 'Czy config deklaruje version 3?',
      where: 'src/core/config/load/io.ts:113',
      inputs: ['version'],
      branches: [
        { if: 'inna wartość lub brak', then: '`Unsupported config version: <v>. Supported: 3. Run splitbrief init --reconfigure to write a current config.`' },
        { if: '3', then: 'mergeWithDefaults', next: 'ST_MERGE_DEFAULTS' }
      ],
      default: 'Nie ma migracji starszych wersji.'
    },
    {
      id: 'ST_MERGE_DEFAULTS',
      title: 'Łączenie z wartościami domyślnymi',
      question: 'Czy BUILD z pliku można uzupełnić polami domyślnego BUILD (Ollama)?',
      where: 'src/core/config/load/defaults.ts:43',
      inputs: ['implementer z pliku'],
      branches: [
        { if: 'brak bloku implementer', then: 'domyślny BUILD Ollama' },
        { if: 'inny kind niż api', then: 'blok z pliku bez domieszki' },
        { if: 'inny provider niż ollama', then: 'blok z pliku bez domieszki (walidacja zgłosi brak model/apiBase)' },
        { if: 'ten sam kind i provider', then: 'domyślne pola + pola z pliku' }
      ],
      default: 'Brak bloku planner: claude-code. validation i workflow: domyślne + plik. Inne klucze przechodzą do walidacji.'
    },
    {
      id: 'ST_SCHEMA_VALID',
      title: 'Walidacja schematu',
      question: 'Czy config przechodzi schemat i reguły dodatkowe?',
      where: 'src/core/config/load/io.ts:119',
      inputs: ['ConfigSchema (Zod)', 'usunięte rodzaje i klucze', 'outputFormat', 'klucze API'],
      branches: [
        { if: 'kind `agent-sdk`', then: 'błąd `Runner kind "agent-sdk" was removed; use kind cli, api, shell, or agent.`' },
        { if: 'klucz top-level otel, snapshots, trust, plannerEstimateReview, autoSplitOverflow, compiler', then: 'błąd Unknown config key (dla compiler: osobny komunikat)' },
        { if: 'nieznany klucz w workflow (strictObject)', then: 'błąd `Unknown config key — remove it or use the current spelling...`' },
        { if: 'outputFormat dla antigravity/claude-code/codex/command-code/cursor', then: 'błąd: nie może zastąpić natywnego kontraktu' },
        { if: 'błąd klucza API', then: 'błąd apiKeyErrors' },
        { if: 'brak błędów', then: 'Config + ostrzeżenia bezpieczeństwa ({prompt} w args shell/agent)', next: 'ST_RETIRED_VALUES' }
      ],
      default: 'Komunikat: `Configuration errors in .splitbrief/config.yaml:` + linie `ścieżka: komunikat`.',
      notes: 'Nieznany klucz na najwyższym poziomie (poza listą usuniętych) jest tolerowany, bo obiekt główny nie jest strict.'
    },
    {
      id: 'ST_RETIRED_VALUES',
      title: 'Wycofane klucze, które wciąż się wczytują',
      question: 'Czy plik używa klucza lub wartości wycofanej w tym wydaniu?',
      where: 'src/core/config/load/validation/config.ts:191',
      inputs: ['surowy config po merge'],
      branches: [
        { if: 'workflow.mode, task_review, brief_review, speckit, drift_chain_threshold, max_retries', then: 'notice `... was retired and is ignored ... Delete ...`' },
        { if: 'workflow.approve all, spec, default', then: 'wczytany jako plan + notice' },
        { if: 'approval.tiers, approval.enabled', then: 'notice: zapis do chronionej ścieżki zawsze pyta' },
        { if: 'validation.typecheck, lint, test, typecheck_command, lint_command', then: 'notice: reviewer wybiera komendy, end_checks je włącza' },
        { if: 'escalation', then: 'notice: konsultacja plannera zastępuje poziom pośredni' }
      ],
      default: 'Bez notice.',
      notes: 'Każda uwaga jest wypisana raz na proces i projekt (`src/core/config/runtime/effective-config.ts:53`) jako `⚠ <tekst>` na stderr; w TUI trafia do linii feedback po montażu.'
    },
    {
      id: 'ST_OVERRIDE_VALID',
      title: 'Nadpisania z flag CLI',
      question: 'Czy flagi seatów dają poprawny config efektywny?',
      where: 'src/core/config/runtime/effective-config.ts:67',
      inputs: ['--planner*, --implementer*, --reviewer*, --model, --provider, --planner-effort, --reviewer-effort'],
      branches: [
        { if: 'zły poziom effort', then: 'błąd invalidOverride `Must be one of: none, minimal, low, medium, high, xhigh, max`' },
        { if: 'flaga nie pasuje do rodzaju seatu (np. --planner-api-base dla cli)', then: 'ostrzeżenie `... is ignored`, wartość odrzucona' },
        { if: 'wynik nie przechodzi schematu', then: 'błąd walidacji `effective config`' },
        { if: 'ok', then: 'config efektywny tylko dla tego wywołania (plik bez zmian)' }
      ],
      default: 'Brak flag: config z pliku.'
    },
    {
      id: 'ST_FIRST_RUN_PATH',
      title: 'Kto tworzy pierwszy config',
      question: 'Która droga zapisze pierwszy config.yaml?',
      where: 'src/cli/setup.ts:90',
      inputs: ['komenda', 'tryb'],
      branches: [
        { if: 'start w TUI, init w TUI', then: 'ekran Setup', next: 'ST_SETUP_STEP' },
        { if: 'start --json/--plain, spec, review, init --yes', then: 'ensureHeadlessConfig', next: 'ST_HEADLESS_CONFIG' },
        { if: 'doctor, status, resume, continue', then: 'nic nie zapisuje (doctor: bloker config.missing)' }
      ],
      default: 'Brak.'
    },
    {
      id: 'ST_HEADLESS_CONFIG',
      title: 'Czy zapis headless jest potrzebny',
      question: 'Czy config już istnieje?',
      where: 'src/cli/setup.ts:90',
      inputs: ['revision configu', '--reconfigure (init --yes)'],
      branches: [
        { if: 'config jest i brak --reconfigure', then: 'nic; dalej config z pliku' },
        { if: 'inaczej', then: 'detectAll + wybór załogi', next: 'ST_DEFAULT_CREW' }
      ],
      default: 'Brak.'
    },
    {
      id: 'ST_DEFAULT_CREW',
      title: 'Automatyczny wybór załogi',
      question: 'Która gotowa załoga wynika z wykrycia?',
      where: 'src/core/crew/default.ts:81',
      inputs: ['narzędzia CLI w stanie ready', 'Ollama dostępna i jej modele'],
      branches: [
        { if: 'brak gotowego narzędzia na PLAN (kolejność claude-code, codex, reszta)', then: 'null' },
        { if: 'Ollama dostępna z modelami', then: 'BUILD = Ollama z `qwen3-coder:30b` albo pierwszym modelem' },
        { if: 'brak Ollamy, jest gotowe narzędzie BUILD (opencode, codex, claude-code, reszta)', then: 'BUILD = to narzędzie CLI' },
        { if: 'brak czegokolwiek na BUILD', then: 'null' }
      ],
      default: 'REVIEW nie jest ustawiany: planner trzyma seat review. Flagi seatów zastępują tylko te seaty, które nadpisują (`selectInitialCrew`, `default.ts:40`).',
      next: 'ST_CREW_AVAILABLE'
    },
    {
      id: 'ST_CREW_AVAILABLE',
      title: 'Czy załoga do zapisu jest dostępna',
      question: 'Czy każdy seat efektywnej załogi jest gotowy?',
      where: 'src/cli/setup.ts:118',
      inputs: ['checkCrewAvailability', 'listy modeli tras CLI', 'probe dostawców API'],
      branches: [
        { if: 'niedostępny seat i nic nie wykryto', then: 'CliError `No config found and no ready crew is available. Run splitbrief init to choose and sign in to your tools.`, exit 1, bez zapisu' },
        { if: 'niedostępny seat przy wykrytej załodze', then: 'CliError `<seat> is unavailable. Choose a ready tool and model, then retry...`, exit 1' },
        { if: 'wszystko dostępne', then: 'zapis', next: 'ST_CONFIG_SAVE' }
      ],
      default: 'Brak.'
    },
    {
      id: 'ST_CONFIG_SAVE',
      title: 'Atomowy zapis configu',
      question: 'Czy zapis się udał?',
      where: 'src/cli/setup.ts:130',
      inputs: ['initConfig z expectedRevision'],
      branches: [
        { if: 'conflict (plik zmienił się w trakcie)', then: 'CliError `Config changed during setup. Retry the command.`, exit 1' },
        { if: 'durability-uncertain', then: 'CliError `Could not finish saving the crew. Retry the command.`, exit 1' },
        { if: 'saved', then: '`No config found. Saved a ready crew to .splitbrief/config.yaml.` + `Added .splitbrief/ to .gitignore` gdy dodano regułę' }
      ],
      default: 'Brak.',
      notes: 'Efektywna załoga (z flagami) idzie dalej do przygotowania, choć zapisana może być inna (wykryta).'
    },
    {
      id: 'ST_SETUP_STEP',
      title: 'Ekran Setup: krok wykrywania',
      question: 'Czy wykrywanie narzędzi skończyło się?',
      where: 'src/app/screens/setup.tsx:579',
      inputs: ['detectionStore.refresh.readiness', 'zapamiętane wykrycie', 'noConfig'],
      branches: [
        { if: 'config jest i jest zapamiętane wykrycie', then: 'od razu krok crew (z dopiskiem `remembered results`)' },
        { if: 'w toku', then: 'panel `Choose your crew after the tool check.` (bez configu) lub BootManifest; esc quit' },
        { if: 'failed lub stale z błędem', then: '`Your tools could not be checked.` r retry, s settings, esc quit' },
        { if: 'fresh', then: 'krok crew', next: 'ST_SETUP_INITIAL_CREW' }
      ],
      default: 'discovery.'
    },
    {
      id: 'ST_SETUP_INITIAL_CREW',
      title: 'Propozycja załogi w Setup',
      question: 'Czy wykrycie daje domyślną załogę?',
      where: 'src/app/screens/setup.tsx:590',
      inputs: ['noConfig', 'wykrycie fresh'],
      branches: [
        { if: 'tak (raz)', then: 'configStore.setInitialCrew(załoga)' },
        { if: 'nie', then: 'zostaje config domyślny; seaty pokazują `Unavailable`' }
      ],
      default: 'Kursor startuje na wierszu PLAN (`initialKey: seat:plan`).'
    },
    {
      id: 'ST_PRESET_READY',
      title: 'Gotowe załogi (presety)',
      question: 'Czy preset da się zastosować?',
      where: 'src/core/crew/presets.ts:119',
      inputs: ['3 presety: Claude crew + Codex review, Codex crew + Claude review, Claude plan + OpenCode build', 'wykrycie'],
      branches: [
        { if: 'preset ma narzędzie niegotowe (notReady)', then: 'Enter nic nie robi (`src/app/screens/setup.tsx:394`), podpowiedź `this crew needs ready tools`' },
        { if: 'wszystko gotowe', then: 'preset podmienia seaty; seat już na tym narzędziu jest zachowany z modelem' }
      ],
      default: 'Wiersz seatu otwiera picker seatu → zobacz ui/runners.'
    },
    {
      id: 'ST_SETUP_CONTINUE',
      title: 'Continue w Setup',
      question: 'Czy każdy seat (efektywny i zapisywany) jest dostępny?',
      where: 'src/app/screens/setup.tsx:651',
      inputs: ['unavailableSetupSeats dla configu efektywnego i zapisywanego'],
      branches: [
        { if: 'są niedostępne', then: 'błąd `Choose a ready tool and model for each unavailable seat.`' },
        { if: 'w międzyczasie zmienił się config lub wykrycie', then: 'porzuć ten zapis' },
        { if: 'błąd zapisu', then: 'komunikat reportConfigSaveFailure' },
        { if: 'ok', then: 'configStore.save', next: 'ST_SETUP_ONCOMPLETE' }
      ],
      default: 'Brak.'
    },
    {
      id: 'ST_SETUP_ONCOMPLETE',
      title: 'Co po zapisie załogi',
      question: 'Czy Setup otworzył start z opisem feature?',
      where: 'src/app/screens/setup.tsx:658',
      inputs: ['onComplete', 'pendingFeature'],
      branches: [
        { if: 'workflow + feature', then: 'preparation.submit (Checking tools); blokada pokazuje panel Tool preparation · Blocked na ekranie Setup; prepared → ekran workflow' },
        { if: 'inaczej', then: 'home + `Saved your crew ...`' }
      ],
      default: 'home.'
    },
    {
      id: 'ST_SKILLS',
      title: '--skills w headless',
      question: 'Czy każde id skilla istnieje?',
      where: 'src/cli/headless.ts:251',
      inputs: ['--skills', 'discoverSkills'],
      branches: [
        { if: 'nieznane id', then: 'CliError `Unknown skill: <id> (scanned: ...)`, exit 2, przed przygotowaniem' },
        { if: 'wszystkie znane', then: 'skille dla każdego seatu' }
      ],
      default: 'Bez flagi: brak skilli.'
    },
    {
      id: 'ST_SEAT_DOWN_SWITCH',
      title: '--on-seat-down switch bez fallback',
      question: 'Czy jest się na co przełączyć?',
      where: 'src/cli/headless.ts:365',
      inputs: ['--on-seat-down', 'fallback w seatach i profilach'],
      branches: [
        { if: 'switch i żaden seat nie ma fallback', then: 'CliError `--on-seat-down switch needs a seat that declares fallback...`, exit 2' }
      ],
      default: 'Dalej.',
      notes: 'Sprawdzane dopiero po przygotowaniu, więc folder sesji już istnieje (zobacz gotchas).'
    },
    {
      id: 'ST_HEADLESS_AUTO_SWAP',
      title: 'Automatyczna zamiana seatu w headless',
      question: 'Czy halt zostawił automatyczną intencję zamiany seatu?',
      where: 'src/cli/headless.ts:382',
      inputs: ['pendingRecovery.switchSeat.auto', '--on-seat-down'],
      branches: [
        { if: 'jest i polityka nie halt', then: 'applyOfferedSeatSwap z polityką resume headless; gdy halt dalej czeka → recovery_required, exit 1' },
        { if: 'brak lub halt', then: 'dalej' }
      ],
      default: 'Szczegóły → zobacz recovery.'
    },
    {
      id: 'ST_HEADLESS_RESUME_PENDING',
      title: 'Wznowienie headless z czekającym recovery',
      question: 'Czy wznawiany run czeka na odpowiedź człowieka?',
      where: 'src/cli/headless.ts:416',
      inputs: ['purpose resume', 'pendingRecovery', 'pendingPlannerConversation'],
      branches: [
        { if: 'pytanie plannera bez odpowiedzi', then: 'input_required + `The planner needs your reply.` + `Continue with: ...`, exit 1' },
        { if: 'recovery bez odpowiedzi', then: 'recovery_required + 3 linie na stderr, exit 1' },
        { if: 'brak', then: 'runWorkflow' }
      ],
      default: 'Headless nigdy nie robi ponowienia za człowieka.'
    },
    {
      id: 'ST_HEADLESS_STOPPED',
      title: 'Sygnał w headless',
      question: 'Czy run zatrzymał SIGINT, SIGTERM lub SIGHUP?',
      where: 'src/cli/headless.ts:464',
      inputs: ['pierwszy sygnał'],
      branches: [
        { if: 'tak', then: 'run zatrzymany wznawialnie; `Run <id> stopped. Continue with: splitbrief continue <id>`; exit 130, 143 lub 129' },
        { if: 'nie', then: 'oceń stan końcowy', next: 'ST_HEADLESS_FINAL' }
      ],
      default: 'Apply nie ma stopu: kończy się i zapisuje rekord, potem proces wychodzi.'
    },
    {
      id: 'ST_HEADLESS_LOOP',
      title: 'Ponowne wejście po zamianie seatu',
      question: 'Czy inny seat padł z automatyczną intencją?',
      where: 'src/cli/headless.ts:458',
      inputs: ['--on-seat-down', 'stan po runWorkflow'],
      branches: [
        { if: '--on-seat-down halt', then: 'koniec pętli' },
        { if: 'jest nowa intencja auto', then: 'kolejna iteracja', next: 'ST_HEADLESS_AUTO_SWAP' },
        { if: 'brak', then: 'koniec pętli' }
      ],
      default: 'Koniec pętli.'
    },
    {
      id: 'ST_HEADLESS_FINAL',
      title: 'Kod wyjścia headless',
      question: 'Jak skończył się run?',
      where: 'src/cli/headless.ts:472',
      inputs: ['stan końcowy', 'deriveRunStatus'],
      branches: [
        { if: 'pytanie plannera lub recovery czeka', then: 'input_required / recovery_required, exit 1' },
        { if: 'ready-to-apply (worktree, staged-copy)', then: 'ready_to_apply + `Apply with: ... --action apply`, exit 0' },
        { if: 'closed complete (checkout)', then: 'exit 0' },
        { if: 'review failed', then: 'final_review_failed z liczbą blokujących, exit 1' },
        { if: 'stop reason failed', then: 'error `Session <id> failed.` + ostatni błąd, exit 1' },
        { if: 'faza final-review', then: 'final_review_incomplete, exit 1' },
        { if: 'sesja nie complete', then: 'error + `Workflow was cancelled.` lub `Workflow did not complete — the run stopped early.`, exit 1' }
      ],
      default: 'exit 0.'
    },
    {
      id: 'ST_RESUME_ACTIVE',
      title: 'resume: tylko aktywny run',
      question: 'Czy jest martwy aktywny run do wznowienia?',
      where: 'src/cli/commands/resume.ts:32',
      inputs: ['.splitbrief/active', 'checkSessionLiveness'],
      branches: [
        { if: 'brak active', then: 'CliError `no active session to resume.`, exit 1' },
        { if: 'run żyje', then: 'CliError `session ... is running — stop it before resuming...`, exit 1' },
        { if: 'proces istnieje, ale nie odpowiada', then: 'CliError `session process <pid> exists but is unresponsive — kill it first`, exit 1' },
        { if: 'stan invalid lub brak state.json', then: 'exit 1' },
        { if: 'headless i czeka recovery', then: 'recovery_required, exit 1' },
        { if: 'ok', then: 'resumeSavedSession', next: 'ST_RESUMABLE' }
      ],
      default: 'Brak.'
    },
    {
      id: 'ST_CONTINUE_TARGET',
      title: 'continue: który run',
      question: 'Jak rozwiązać argument id?',
      where: 'src/cli/commands/continue/command.ts:56',
      inputs: ['id, nazwa lub numer', 'active'],
      branches: [
        { if: 'liczba', then: 'alias: n-ty run od najnowszego; < 1, brak sesji lub poza zakresem → exit 1' },
        { if: 'nazwa', then: 'folder sesji musi istnieć, inaczej `session ... not found`, exit 1' },
        { if: 'brak id', then: 'wskaźnik active' },
        { if: 'brak id i active', then: 'CliError `no session to continue; start one with splitbrief start.`, exit 1' }
      ],
      default: 'Brak.'
    },
    {
      id: 'ST_CONTINUE_STATE',
      title: 'continue: stan zapisanego runu',
      question: 'Czy run da się kontynuować?',
      where: 'src/cli/commands/continue/command.ts:154',
      inputs: ['loadRunRecord'],
      branches: [
        { if: 'stan invalid lub missing', then: 'exit 1 z opisem' },
        { if: 'running', then: '`is still running — stop it before continuing.`, exit 1' },
        { if: 'closed', then: '`Run <id> is closed (<as>); nothing to resume.` (z --json rekord error), exit 1' },
        { if: 'open lub ready-to-apply', then: 'dalej', next: 'ST_CONTINUE_ACTION' }
      ],
      default: 'Brak.'
    },
    {
      id: 'ST_CONTINUE_ACTION',
      title: 'continue --action',
      question: 'Co zrobić przed wznowieniem?',
      where: 'src/cli/commands/continue/command.ts:186',
      inputs: ['--action: skip, retry, restore, switch-seat:<seat>, end-run, apply, discard'],
      branches: [
        { if: 'end-run', then: 'zamknij run (odmowa przy niedokończonym Apply), `Run <id> closed.`, exit 0' },
        { if: 'apply lub discard', then: 'run musi być ready-to-apply (inaczej exit 1); settleReadyRun; Apply może wrócić do review' },
        { if: 'restore', then: 'odpowiedz recovery, potem Apply at rest' },
        { if: 'skip, retry, switch-seat', then: 'najpierw sprawdzenie TTY (dla TUI), potem applyRecoveryAction; odmowa → exit 1; switch-seat zapisuje seat w configu' },
        { if: 'zła wartość', then: 'CliError exit 2 już przy parsowaniu (`src/cli/options.ts:149`)' },
        { if: 'brak', then: 'tylko sprawdzenie TTY' }
      ],
      default: 'Szczegóły akcji → zobacz recovery i lifecycle.'
    },
    {
      id: 'ST_RESUMABLE',
      title: 'Czy run jest wznawialny',
      question: 'Czy run jest closed albo ready-to-apply?',
      where: 'src/cli/sessions/resolve.ts:31',
      inputs: ['deriveRunStatus'],
      branches: [
        { if: 'closed', then: '`Run <id> is closed (<as>); nothing to resume.`, exit 1' },
        { if: 'ready-to-apply', then: '`Run <id> is ready to apply.` + linie Apply/Discard, exit 1' },
        { if: 'open', then: 'dalej', next: 'ST_RESUME_MODE' }
      ],
      default: 'Brak.'
    },
    {
      id: 'ST_RESUME_MODE',
      title: 'Wznowienie: headless czy TUI',
      question: 'Czy podano --json lub --plain?',
      where: 'src/cli/commands/continue/resume.ts:114',
      inputs: ['opts.json', 'opts.plain'],
      branches: [
        { if: 'headless', then: 'prepareExecution(resume, headless) i runHeadless; bez setupWorkflow i bez pytania o hooki' },
        { if: 'TUI', then: '`Resuming: <feature> (task n/m)`, setupWorkflow, initStores (pytanie o hooki), prepareExecution(resume), hydrateRun, ekran workflow' }
      ],
      default: 'Przed przygotowaniem: uwagi o zmianie seatów na stderr.'
    },
    {
      id: 'ST_DOCTOR_MODE',
      title: 'doctor: raport czy sonda seatu',
      question: 'Czy podano --probe-seat?',
      where: 'src/cli/commands/doctor.ts:418',
      inputs: ['--probe-seat', '--json', 'stdin.isTTY'],
      branches: [
        { if: '--probe-seat plan/build/review', then: 'jedno płatne wywołanie `Reply with the word ok.` w pustym katalogu; rekord w .splitbrief/probes/; `Seat probe <seat>: <class>`' },
        { if: 'zły seat lub seat nie cli', then: 'exit 1' },
        { if: 'bez sondy, --json lub brak TTY', then: 'interakcja headless: raport + replay dopuszczenia seatów jak headless start' },
        { if: 'bez sondy, TTY', then: 'interakcja interactive: bez replay dopuszczenia' }
      ],
      default: 'Raport gotowości.',
      next: 'ST_DOCTOR_EXIT'
    },
    {
      id: 'ST_DOCTOR_EXIT',
      title: 'doctor: kod wyjścia',
      question: 'Czy raport jest blocked?',
      where: 'src/cli/commands/doctor.ts:464',
      inputs: ['report.status'],
      branches: [
        { if: 'blocked', then: 'raport (lub rekord JSON) i exit 1 bez linii Error' },
        { if: 'ready lub ready-with-warnings', then: 'exit 0' }
      ],
      default: 'Sonda seatu: exit 0 niezależnie od wyniku wywołania.'
    },
    {
      id: 'ST_STATUS_ACTIVE',
      title: 'status',
      question: 'Czy jest aktywny run ze stanem?',
      where: 'src/cli/commands/status.ts:81',
      inputs: ['.splitbrief/active', 'state.json'],
      branches: [
        { if: 'nie', then: '`No active workflow.`' },
        { if: 'tak', then: 'Feature, Status (słowo statusu runu), Task n/m, Started, Session, PLAN/BUILD/REVIEW (z uwzględnieniem seatSwitches), Done/Escalated/Failed' }
      ],
      default: 'Zawsze exit 0. Nie wczytuje configu jako warunku.'
    },
    {
      id: 'ST_INIT_EXISTS',
      title: 'init: config już jest',
      question: 'Czy config istnieje bez --reconfigure?',
      where: 'src/cli/commands/init.ts:42',
      inputs: ['config.yaml', '--reconfigure'],
      branches: [
        { if: 'tak', then: '`Config already exists at .splitbrief/config.yaml` + `Use --reconfigure to overwrite.`, exit 0' },
        { if: 'nie', then: 'dalej', next: 'ST_INIT_YES' }
      ],
      default: 'Brak.'
    },
    {
      id: 'ST_INIT_YES',
      title: 'init: --yes czy ekran',
      question: 'Zapis bez ekranu czy Setup?',
      where: 'src/cli/commands/init.ts:48',
      inputs: ['--yes', 'stdin.isTTY'],
      branches: [
        { if: '--yes', then: 'ensureHeadlessConfig (z --reconfigure: nadpisz), `Run splitbrief doctor to check readiness...`' },
        { if: 'brak --yes, brak TTY', then: 'CliError `interactive mode needs a TTY — use --yes ...`, exit 1' },
        { if: 'brak --yes, TTY', then: 'initStores (może zapytać o hooki), ekran Setup, potem home' }
      ],
      default: 'init nie sprawdza repo git.'
    },
    {
      id: 'ST_SPEC_OUTCOME',
      title: 'spec: wynik sesji planowania',
      question: 'Czy sesja dała plan?',
      where: 'src/cli/commands/spec.ts:237',
      inputs: ['PlanSessionOutcome', 'TTY dla odpowiedzi na pytania'],
      branches: [
        { if: 'plan', then: 'plan.json, plan.md, tasks.md; `Planning complete.`, exit 0' },
        { if: 'seat-protocol', then: 'błąd protokołu, rollback sesji, exit 1' },
        { if: 'questions-exhausted', then: '`The planner asked a third round of questions...`, exit 1' },
        { if: 'checks-failed', then: '`The plan failed its checks again after one repair:` + lista, exit 1' }
      ],
      default: 'Bez TTY każde pytanie dostaje odpowiedź domyślną.',
      notes: 'Kolejność spec: git → ensureHeadlessConfig → clear stale → loadConfig → pytanie o hooki → effective config → prepareExecution(spec: tylko PLAN) → sesja. Szczegóły → zobacz planning.'
    },
    {
      id: 'ST_REVIEW_DIFF',
      title: 'review: czy jest co oceniać',
      question: 'Czy diff (z nieśledzonymi plikami) jest pusty?',
      where: 'src/cli/commands/review.ts:147',
      inputs: ['git diff (lub --base ref)', 'nieśledzone pliki poza .splitbrief/ i .trees/'],
      branches: [
        { if: 'pusty', then: '`nothing to review`, exit 0, bez tworzenia seatu' },
        { if: 'niepusty', then: 'prepareReviewExecution (tylko seat REVIEW, żywy run to info), jedno typowane wywołanie; review.json i review.md w .splitbrief/reviews/<stamp>/' }
      ],
      default: 'Exit 0 przy każdym werdykcie; exit 1 przy braku git, złym configu, blokadzie lub błędzie wywołania.',
      notes: 'ensureHeadlessConfig działa przed sprawdzeniem diffu, więc przy braku configu review zapisuje config nawet wtedy, gdy nie ma czego oceniać.'
    }
  ],
  config: [
    { key: 'version', values: '3', default: 'brak (wymagane)', effect: 'Każda inna wartość: `Unsupported config version` i exit 1. Brak migracji.', where: 'src/core/config/load/io.ts:113' },
    { key: 'planner / implementer / reviewer / implementerProfiles', values: 'kind: cli | api | shell | agent', default: 'planner: claude-code CLI; implementer: Ollama qwen3-coder:30b; reviewer: brak (planner trzyma review)', effect: 'Które seaty przygotowanie sprawdza i jak. Każdy profil BUILD musi być gotowy. Szczegóły → zobacz runners.', where: 'src/core/config/load/defaults.ts:7' },
    { key: 'workflow.approve', values: 'plan | none (all, spec, default → plan + notice)', default: 'plan', effect: 'Readiness info; headless zatwierdza plan bez człowieka. → zobacz planning.', where: 'src/core/schemas/config.ts:86' },
    { key: 'workflow.isolation', values: 'worktree | staged-copy | none', default: 'worktree (ale brak klucza w pliku liczy się osobno)', effect: 'Brak klucza + monorepo/editable venv/go.work/Cargo workspace = BLOKER. none wycisza; worktree/staged-copy daje ostrzeżenie. Zmienia też tekst ostrzeżenia o brudnym drzewie.', where: 'src/core/readiness/checks/isolation.ts:100' },
    { key: 'validation.end_checks', values: 'true | false', default: 'true', effect: 'false daje ostrzeżenie `validation.end-checks-off`.', where: 'src/core/readiness/checks/validation.ts:58' },
    { key: 'validation.test_command', values: 'komenda', default: 'z manifestu/stosu', effect: 'Brak: info `No test command found.`; `npm run x` bez skryptu: ostrzeżenie.', where: 'src/core/readiness/checks/validation.ts:47' },
    { key: 'planner.context_length / implementer.context_length', values: 'liczba tokenów', default: 'auto', effect: 'Poniżej 32000: ostrzeżenie `context.<rola>.tight`.', where: 'src/core/readiness/checks/context.ts:58' },
    { key: 'hooks', values: 'pre_planning, pre_task, post_task, ...', default: 'brak', effect: 'TUI i spec pytają o zaufanie; bez zaufania hook jest odrzucany w trakcie runu. → zobacz subsystems.', where: 'src/cli/hook-trust-prompt.ts:40' },
    { key: 'workflow.mode, task_review, brief_review, speckit, drift_chain_threshold, max_retries; approval.tiers, approval.enabled; validation.typecheck, lint, test, typecheck_command, lint_command; escalation', values: 'dowolne', default: 'brak', effect: 'Wycofane: wczytują się z jedną uwagą `... was retired and is ignored` i nic nie zmieniają.', where: 'src/core/config/load/validation/config.ts:121' },
    { key: 'otel, snapshots, trust, plannerEstimateReview, autoSplitOverflow, compiler; kind agent-sdk', values: 'dowolne', default: 'brak', effect: 'Usunięte: błąd walidacji, config się nie wczytuje.', where: 'src/core/config/load/validation/config.ts:95' },
    { key: 'uprawnienia pliku config.yaml', values: 'tryb pliku', default: '0600 przy zapisie', effect: 'Grupa/inni mogą zmieniać: tylko uwaga `run chmod 600`.', where: 'src/core/config/load/io.ts:94' },
    { key: '--json / --plain', values: 'flaga', default: 'false', effect: 'Headless: brak TUI, brak pytań, kod wyjścia jako wynik; razem: exit 2.', where: 'src/cli/options.ts:313' },
    { key: '--allow-hooks', values: 'flaga', default: 'false', effect: 'TUI start/resume/continue, init, spec: ufa hookom bez pytania i zapisuje receipt. Headless start/resume/continue: brak efektu na zaufanie (zobacz gotchas).', where: 'src/cli/hook-trust-prompt.ts:51' },
    { key: '--allow-repo-runners', values: 'flaga', default: 'false', effect: 'Dopuszcza komendy shell/agent leżące w repo na ten run.', where: 'src/engine/runners/prepare-execution/evaluate-candidate.ts:529' },
    { key: '--allow-unverified-auth', values: 'flaga', default: 'false', effect: 'Headless dopuszcza CLI z nieznanym stanem logowania; TUI i tak ujawnia zamiast blokować.', where: 'src/cli/commands/start/readiness.ts:242' },
    { key: '--on-seat-down', values: 'halt | switch', default: 'brak (fallback stosowany, gdy zadeklarowany)', effect: 'Headless: halt zatrzymuje na Seat down; switch bez fallback = exit 2.', where: 'src/cli/headless.ts:365' },
    { key: '--skills', values: 'id,id', default: 'brak', effect: 'Headless start i resume/continue; nieznane id = exit 2.', where: 'src/cli/headless.ts:242' },
    { key: '--project', values: 'katalog', default: 'cwd', effect: 'Kanonizowany do toplevel repo git (ostrzeżenie przy podkatalogu).', where: 'src/cli/setup.ts:30' },
    { key: '--no-fullscreen / --no-mouse / --hover', values: 'flagi', default: 'fullscreen i mysz włączone, hover wyłączony', effect: 'Sposób rysowania TUI; w headless bez efektu.', where: 'src/cli/setup.ts:163' },
    { key: '--planner*, --implementer*, --reviewer*, --model, --provider, --planner-effort, --reviewer-effort', values: 'zależnie od flagi', default: 'brak', effect: 'Nadpisują seaty tylko dla tego wywołania; flaga niepasująca do rodzaju seatu jest ignorowana z ostrzeżeniem.', where: 'src/core/config/runtime/overrides/from-options.ts:4' },
    { key: 'continue/resume --action', values: 'skip | retry | restore | switch-seat:<tool>[:<model>][@<effort>] | end-run | apply | discard', default: 'brak', effect: 'Odpowiedź na recovery lub rozliczenie runu gotowego do Apply; zła wartość = exit 2. start nie ma tej flagi.', where: 'src/cli/options.ts:126' },
    { key: 'init --yes / --reconfigure', values: 'flagi', default: 'false', effect: '--yes: zapis wykrytej załogi bez ekranu; --reconfigure: nadpisanie istniejącego configu.', where: 'src/cli/commands/init.ts:28' },
    { key: 'doctor --json / --probe-seat', values: 'flaga / plan|build|review', default: 'brak', effect: '--json: rekord readiness_report i interakcja headless; --probe-seat: jedno płatne wywołanie.', where: 'src/cli/commands/doctor.ts:411' },
    { key: 'review --reviewer / --base', values: '<tool>[:<model>][@<effort>] / git ref', default: 'skonfigurowany reviewer lub planner / drzewo robocze', effect: 'Seat review na to jedno wywołanie; ref nie może zaczynać się od `-`.', where: 'src/cli/commands/review.ts:114' },
    { key: 'env CI', values: 'dowolna wartość', default: 'brak', effect: 'Wyłącza fullscreen i mysz; nie wymusza headless.', where: 'src/cli/setup.ts:57' },
    { key: 'HOME (~/.splitbrief/trust/)', values: 'katalog', default: 'katalog domowy', effect: 'Magazyn receiptów zaufania (hooki, komendy własne); inny HOME = brak zaufania.', where: 'src/core/trust/receipt-store.ts:23' }
  ],
  states: [
    { name: 'exit 0', meaning: 'Sukces: run complete lub ready-to-apply (headless), TUI zamknięte normalnie, doctor bez blokerów, review z dowolnym werdyktem, status zawsze.', where: 'src/cli/render/app.ts:406' },
    { name: 'exit 1', meaning: 'Domyślny błąd CliError: zły Node, usunięta komenda/flaga, literówka, config, brak git/TTY, odmowa hooków, blokada gotowości, run nieskończony, recovery czeka.', where: 'src/cli/errors.ts:12' },
    { name: 'exit 2', meaning: 'Błąd wejścia: @plik, pusty opis przed @plikiem, opis zaczynający się od @, --json z --plain, nieznany --skills, zła --action, switch bez fallback.', where: 'src/cli/commands/start/register.ts:52' },
    { name: 'exit 130 / 143 / 129', meaning: 'SIGINT / SIGTERM / SIGHUP: headless run zatrzymany wznawialnie. TUI wychodzi tymi kodami po sprzątaniu, gdy sygnał przyjdzie z zewnątrz (kill) lub Ctrl+C trafi do systemu zamiast do Ink (`src/cli/render/process-lifecycle.ts:78`).', where: 'src/engine/orchestrator/signals.ts:4' },
    { name: 'readiness ready / ready-with-warnings / blocked', meaning: 'Status raportu gotowości; tylko blocked zatrzymuje start.', where: 'src/core/readiness/status.ts:76' },
    { name: 'preparation idle / checking / blocked / failed', meaning: 'Stan koordynatora przygotowania w TUI; checking pokazuje `Checking tools` przy kompozytorze.', where: 'src/stores/navigation/preparation.ts:21' },
    { name: 'PreparationOutcome prepared / blocked / failed / aborted', meaning: 'Wynik prepareExecution.', where: 'src/engine/runners/prepare-execution/prepare-execution.ts:372' },
    { name: 'Setup step discovery / crew', meaning: 'Ekran Setup: najpierw czeka na wykrycie narzędzi, potem lista załogi.', where: 'src/app/screens/setup.tsx:70' }
  ],
  scenarios: [
    {
      title: 'Szczęśliwa ścieżka: splitbrief start "fix typo" w TUI, config jest, narzędzia gotowe',
      steps: [
        '1. Node 22, brak usuniętych flag, operand ze spacją: strażniki przepuszczają.',
        '2. start: argumenty ok, projectDir = toplevel repo, brak @plików, brak --json/--plain → TUI.',
        '3. stdin TTY, repo git, reapOrphanRunners, fullscreen + mysz.',
        '4. initStoresForTuiMount: config wczytany (ewentualne `⚠ ... retired` wstrzymane do montażu), brak hooków.',
        '5. Ink montuje home; preparationStore.submit z `Checking tools`.',
        '6. prepareStartOutcome: martwy wskaźnik active usunięty, raport ready-with-warnings (np. brudne drzewo), każdy seat admitted, preflight argumentów ok.',
        '7. prepareNewSession: folder sesji, readiness.json, wskaźnik active.',
        '8. navigate workflow → useRunLoop → runWorkflow → initializeWorkflow (planner.isAvailable ok) → runPlanningPhases.'
      ],
      outcome: 'Sesja planowania startuje; ostrzeżenia gotowości są widoczne pod prośbą w transkrypcie.'
    },
    {
      title: 'Pierwszy run w TUI bez configu',
      steps: [
        '1. setupWorkflow zwraca needsSetup: true.',
        '2. configStore.load wczytuje config domyślny (bez błędu), brak hooków.',
        '3. Brak żywego runu → router: setup, onComplete workflow (bo jest feature).',
        '4. Ekran: `Choose your crew after the tool check.`; po wykryciu fresh Setup ustawia wykrytą załogę (np. PLAN claude-code, BUILD opencode).',
        '5. Użytkownik wybiera Continue; oba configi (efektywny i zapisywany) dostępne; configStore.save zapisuje config.yaml i regułę .gitignore.',
        '6. preparation.submit z zapamiętanym opisem → prepared → ekran workflow.'
      ],
      outcome: 'Config zapisany, run startuje bez ponownego wpisywania opisu.'
    },
    {
      title: 'Headless --json bez configu, gotowy tylko Codex',
      steps: [
        '1. setupWorkflow: needsSetup.',
        '2. ensureHeadlessConfig: detectAll; PLAN = codex (claude-code niegotowy); brak Ollamy; BUILD = codex.',
        '3. checkCrewAvailability ok → zapis; stderr `No config found. Saved a ready crew to .splitbrief/config.yaml.`',
        '4. prepareStartExecution z configiem efektywnym; stdout: `{"type":"readiness_report",...}`.',
        '5. runHeadless → runWorkflow; plan card zatwierdzony bez człowieka.'
      ],
      outcome: 'Run idzie na Codex we wszystkich seatach; na końcu ready_to_apply (worktree) i exit 0.'
    },
    {
      title: 'Headless bez configu i bez żadnego gotowego narzędzia',
      steps: [
        '1. ensureHeadlessConfig: selectDetectedDefaultCrew zwraca null.',
        '2. Załoga = config domyślny (claude-code + Ollama) z flagami; checkCrewAvailability: seat niedostępny.'
      ],
      outcome: '`Error: No config found and no ready crew is available. Run splitbrief init to choose and sign in to your tools.` exit 1; config nie powstaje.'
    },
    {
      title: 'Config ze starą wersją (version: 2)',
      steps: [
        '1. TUI start: initStoresForTuiMount → configStore.load → loadConfig rzuca unsupportedVersion przed montażem.',
        '2. main().catch drukuje błąd.',
        '3. doctor: ten sam błąd staje się blokerem `config.invalid` z fix `splitbrief init --reconfigure`.'
      ],
      outcome: '`Error: Unsupported config version: 2. Supported: 3. Run splitbrief init --reconfigure to write a current config.` exit 1.'
    },
    {
      title: 'Codex jako PLAN nie jest zalogowany',
      steps: [
        '1. TUI start z feature: home zamontowany, Checking tools.',
        '2. evaluateCli: auth missing → bloker `PLAN could not start.` ze szczegółem `Codex is not signed in.` i instrukcją logowania.',
        '3. Outcome blocked; próba jest bieżąca → TUI odmontowany.'
      ],
      outcome: 'Na stdout lista blokerów, potem `Error: Run readiness blocked: 1 blocker. Resolve the blocker above (run splitbrief doctor for details).` exit 1. Folder sesji nie powstaje.'
    },
    {
      title: 'Drugi start, gdy pierwszy run jeszcze działa w innym terminalu',
      steps: [
        '1. start z feature: clearStaleSessionForCli widzi żywy run i go zostawia.',
        '2. Raport: bloker `repo.active-session-live` z fix `Stop it, then run splitbrief continue <id> — or delete .splitbrief/active to discard it.`',
        '3. Bez feature (samo TUI): assertNoLiveSessionForCli kończy wcześniej.'
      ],
      outcome: 'exit 1 w obu przypadkach; żywy run nie jest dotknięty.'
    },
    {
      title: 'Hooki w configu, pierwszy start w TUI, odpowiedź N',
      steps: [
        '1. bootstrapStoresHooks: brak receiptu w ~/.splitbrief/trust/hooks.json.',
        '2. stderr: ujawnienie (Executable, Resolved, Arguments, On failure, granice) i `Trust these hooks for this project? [y/N]`.',
        '3. Użytkownik wciska Enter.'
      ],
      outcome: '`Error: Refusing to run with untrusted hooks. Edit .splitbrief/config.yaml or re-run and answer y.` exit 1. Odpowiedź y zapisuje receipt i następny start nie pyta.'
    },
    {
      title: 'Monorepo z npm workspaces, workflow.isolation nieustawione',
      steps: [
        '1. buildIsolationChecks wykrywa `workspaces` w package.json.',
        '2. Klucza w pliku brak → bloker `The project links workspace packages through node_modules. Run in your checkout.` z fix ustawienia isolation.'
      ],
      outcome: 'Start zablokowany do czasu wpisania `workflow.isolation: none` (zalecane) albo `worktree` (wtedy tylko ostrzeżenie).'
    },
    {
      title: 'Literówka: splitbrief doctro',
      steps: [
        '1. Jeden operand bez spacji, odległość 1 (transpozycja) od `doctor`.'
      ],
      outcome: '`Error: unknown command \'doctro\' — did you mean \'doctor\'?` + `If \'doctro\' is the feature you meant, run: splitbrief start "doctro"`, exit 1; żadne narzędzie nie jest wołane.'
    },
    {
      title: 'Headless w CI z hookami i --allow-hooks (zachowanie z kodu)',
      steps: [
        '1. `splitbrief start --json --allow-hooks "x"`: runHeadlessStart nie woła ensureHooksTrusted.',
        '2. allowHooks trafia tylko do runtime przygotowanego wykonania; receipt nie powstaje.',
        '3. Hook pre_planning: runPreHooks → hookTrustRefusal → planowanie anulowane z ostrzeżeniem `pre_planning blocked: hook configuration or hook files changed after trust; re-run with --allow-hooks or approve hooks again`.',
        '4. Hooki post_*: ostrzeżenie `[hook ...] ...` i hook pominięty.'
      ],
      outcome: 'Według kodu run nie planuje (gdy jest pre_planning) mimo --allow-hooks; obejście: zaufać hookom raz przez TUI, `spec --allow-hooks` lub `init`. Nie potwierdzone na żywo.'
    }
  ],
  files: [
    { path: 'src/cli.ts', role: 'Wejście: strażniki, rejestracja 8 komend, main().catch i kod wyjścia' },
    { path: 'src/cli/node-guard.ts', role: 'Odrzuca znany Node < 22' },
    { path: 'src/cli/unknown-command.ts', role: 'Usunięte flagi i komendy, literówki w nazwie komendy' },
    { path: 'src/cli/options.ts', role: 'Wszystkie flagi workflow, parsery, --action, wykluczenie --json/--plain' },
    { path: 'src/cli/errors.ts', role: 'CliError z exitCode' },
    { path: 'src/cli/setup.ts', role: 'canonicalizeProjectDir, setupWorkflow (git, TTY, needsSetup), ensureHeadlessConfig' },
    { path: 'src/cli/commands/start/register.ts', role: 'Komenda start: walidacja argumentów, @pliki, wybór TUI/headless' },
    { path: 'src/cli/commands/start/interactive.ts', role: 'Start w TUI: bootstrap, Setup/home, przygotowanie w tle, wyjście przy blokadzie' },
    { path: 'src/cli/commands/start/streaming.ts', role: 'Start headless: zapis configu, skille, przygotowanie, runHeadless' },
    { path: 'src/cli/commands/start/readiness.ts', role: 'prepareStartOutcome, polityka przygotowania, preparedExecutionOrThrow, strażniki żywej sesji' },
    { path: 'src/cli/bootstrap/init.ts', role: 'Bootstrap store-ów: logger, stan projektu, zaufanie do hooków, discovery' },
    { path: 'src/cli/bootstrap/discovery.ts', role: 'Wykrywanie w tle, zapamiętane katalogi modeli, skille' },
    { path: 'src/cli/hook-trust-prompt.ts', role: 'ensureHooksTrusted: ujawnienie i pytanie y/N' },
    { path: 'src/cli/headless.ts', role: 'runHeadless: pętla zamiany seatów, rekordy NDJSON, kody wyjścia' },
    { path: 'src/cli/commands/continue/command.ts', role: 'continue: wybór runu, --action, wznowienie' },
    { path: 'src/cli/commands/continue/resume.ts', role: 'resumeSavedSession: TUI lub headless' },
    { path: 'src/cli/commands/resume.ts', role: 'resume: tylko aktywny, martwy run' },
    { path: 'src/cli/commands/doctor.ts', role: 'doctor: raport, preflight, replay dopuszczenia, --probe-seat' },
    { path: 'src/cli/commands/review.ts', role: 'review: jedno typowane wywołanie reviewera' },
    { path: 'src/cli/commands/spec.ts', role: 'spec: sesja planowania bez budowy' },
    { path: 'src/cli/commands/init.ts', role: 'init: Setup lub --yes' },
    { path: 'src/cli/commands/status.ts', role: 'status: odczyt aktywnego runu' },
    { path: 'src/engine/runners/prepare-execution/prepare-execution.ts', role: 'prepareExecution: gotowość, dopuszczenie seatów, rewalidacja, preflight, sesja' },
    { path: 'src/engine/runners/prepare-execution/evaluate-candidate.ts', role: 'Werdykt jednego seatu: cli, api, shell/agent' },
    { path: 'src/core/readiness/collect.ts', role: 'collectReadiness: sekcje raportu, izolacja, sandbox' },
    { path: 'src/core/readiness/checks/repo.ts', role: 'Sprawdzenia repo: git, commity, operacje, active, brudne drzewo' },
    { path: 'src/core/readiness/checks/isolation.ts', role: 'Stosy, których worktree nie obsłuży' },
    { path: 'src/core/config/load/io.ts', role: 'loadConfig, wersja 3, walidacja, zapis atomowy' },
    { path: 'src/core/config/load/validation/config.ts', role: 'Usunięte i wycofane klucze, konflikty outputFormat' },
    { path: 'src/core/config/load/defaults.ts', role: 'Config domyślny i łączenie z plikiem' },
    { path: 'src/core/crew/default.ts', role: 'Automatyczny wybór załogi i gotowość seatu' },
    { path: 'src/core/crew/presets.ts', role: 'Trzy gotowe załogi ekranu Setup' },
    { path: 'src/app/screens/setup.tsx', role: 'Ekran Setup: wykrywanie, lista załogi, zapis, start' },
    { path: 'src/stores/navigation/preparation.ts', role: 'Koordynator prób przygotowania w TUI' },
    { path: 'src/core/hooks/trust.ts', role: 'Receipt zaufania hooków w magazynie maszyny' }
  ],
  gotchas: [
    'Headless start (`--json`/`--plain`) oraz headless resume/continue nigdy nie wołają `ensureHooksTrusted`: `runHeadlessStart` (`src/cli/commands/start/streaming.ts:16`) i `resumeSavedSession` w trybie headless (`src/cli/commands/continue/resume.ts:114`) pomijają bootstrap store-ów. `--allow-hooks` trafia tylko do `prepared.runtime.allowHooks`, którego nic nie czyta jako zgody na hooki. Skutek z kodu: niezaufane hooki są odrzucane w trakcie runu (pre_planning anuluje planowanie, `src/engine/orchestrator/run/phases.ts:95`), a docs (CLI-REFERENCE: „pass --allow-hooks in CI to skip the hook-trust prompt”, HOOKS-CONFIG: „Use --allow-hooks in CI”) sugerują, że flaga działa w CI. Potwierdzone tylko czytaniem kodu; wymaga sceptyka i testu na żywo.',
    'Brudne drzewo robocze NIGDY nie blokuje startu (`repo.dirty-worktree` to ostrzeżenie). Blokuje natomiast monorepo z workspace-ami lub editable venv, gdy w pliku nie ma klucza `workflow.isolation`, nawet jeśli domyślna izolacja to worktree.',
    'Na Linuksie BUILD na claude-code bez `bwrap` i `socat` w PATH (tylko wpisy absolutne) jest blokerem, zanim planner wyda jakikolwiek token.',
    '`loadConfig` przy braku pliku zwraca config domyślny (PLAN claude-code, BUILD Ollama `qwen3-coder:30b`) bez błędu. Brak configu blokuje tylko w `doctor` (bloker `config.missing`); TUI otwiera Setup, headless zapisuje załogę.',
    'Strażnik Node odrzuca tylko major < 22. package.json deklaruje `^22 || ^24`, więc Node 23 i 25 przechodzą strażnika.',
    '`--on-seat-down switch` bez żadnego fallback daje exit 2 dopiero po przygotowaniu (`src/cli/headless.ts:365`), czyli po utworzeniu folderu sesji i wskaźnika active. Następny start uzna ten wskaźnik za martwy i go wyczyści, ale folder sesji zostaje.',
    '`review` woła `ensureHeadlessConfig` przed sprawdzeniem diffu: bez configu zapisuje config nawet przy `nothing to review`. Docs mówią, że czysty tree kończy „before any runner is constructed”; to prawda, ale detekcja narzędzi i zapis configu już się odbyły. `review` kończy exit 0 także przy werdykcie z blokującymi uwagami.',
    'Headless resume/continue pomijają `setupWorkflow`: brak sprawdzenia repo git i brak `reapOrphanRunners` w tej drodze (TUI resume je robi).',
    'W TUI start z wiersza poleceń, który trafi na blokadę, zamyka cały TUI i drukuje raport na stdout. Ten sam bloker przy starcie z ekranu home lub Setup pokazuje panel `Tool preparation · Blocked` (r retry, esc back, s settings) i TUI zostaje.',
    'Zaufanie do hooków jest pytane przez readline na stderr PRZED montażem Ink, więc w TUI pytanie pojawia się w zwykłym terminalu, a nie w panelu.',
    'Uwagi o wycofanych kluczach configu pokazują się raz na proces i projekt; w TUI czekają do montażu ekranu (withHeldDiagnostics), potem trafiają do linii feedback i na stderr przy wyjściu.',
    '`init` nie sprawdza repo git (ani w TUI, ani z `--yes`), a TUI `init` zawsze rysuje fullscreen, niezależnie od `CI` i `--no-fullscreen` (init nie ma tej flagi).',
    'Seaty fallback nie są sprawdzane przy starcie; przygotowanie sprawdza tylko seaty, które run woła (spec: tylko PLAN, review: tylko REVIEW, start: PLAN + każdy profil BUILD + jawny REVIEW).',
    'W TUI nieznany stan logowania (auth unknown) jest zawsze dopuszczany z ujawnieniem; `--allow-unverified-auth` ma znaczenie tylko w headless (i w `doctor` uruchomionym bez TTY lub z `--json`).'
  ]
});
