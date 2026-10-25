window.ATLAS = window.ATLAS || [];
window.ATLAS.push({
  id: 'configuration',
  order: 11,
  title: 'Konfiguracja: pełna lista',
  tagline: 'Każdy klucz config.yaml, każda flaga CLI, każda zmienna środowiskowa, każdy plik ustawień i każda ukryta stała: skąd się bierze wartość, kto ją czyta i co wygrywa przy konflikcie.',
  summary: `Ten obszar jest **referencją konfiguracji zbudowaną z kodu**, nie z dokumentacji. Źródłem prawdy są schematy Zod (\`src/core/schemas/config.ts\`, \`runner-fields.ts\`, \`hooks.ts\`, \`codebase.ts\`), loader (\`src/core/config/load/\`), akcesory (\`src/core/config/accessors/\`, \`runtime/\`), rejestracje komend (\`src/cli/options.ts\`, \`src/cli/commands/\`) i każde \`process.env.X\` w \`src/\`. Gdzie dokumentacja mówi inaczej niż kod, wygrywa kod; różnice są w sekcji Pułapki.

**Warstwy i kolejność ładowania.** Jedna funkcja, \`loadConfig\` (\`src/core/config/load/io.ts:145\`), czyta \`.splitbrief/config.yaml\`. Kolejność jest stała: (1) brak pliku daje \`createDefaultConfig()\` bez ostrzeżeń; (2) YAML jest parsowany i musi być obiektem; (3) klucze \`snake_case\` są przepisywane na \`camelCase\` (\`transform.ts\`), przy dwu pisowniach wygrywa późniejsza; (4) \`version\` musi być równe \`3\`, inaczej \`config-unsupported-version\`; (5) \`mergeWithDefaults\` dopisuje tylko: domyślny \`planner\` (claude-code), domyślny \`implementer\` (Ollama, qwen3-coder:30b, temperature 0.3), \`validation.endChecks: true\`, \`workflow.approve: plan\`, \`workflow.review: end\`, \`workflow.compactionFormat: auto\`; (6) \`validateConfig\` uruchamia schemat Zod i dopisuje własne błędy: usunięte klucze główne, usunięte kinds i providery, konflikt \`outputFormat\`, błędy poświadczeń; (7) zapisane są notice o kluczach wycofanych (\`retiredValueNotices\`). Potem \`resolveEffectiveConfig\` (\`runtime/effective-config.ts:59\`) nakłada flagi CLI (\`applyCLIOverrides\`) i **waliduje wynik drugi raz**. Zmienne środowiskowe nie są warstwą konfiguracji: tylko \`SPLITBRIEF_CONTEXT_LENGTH\` nadpisuje wartość z pliku, a \`apiKey: env:VAR\` jest odwołaniem rozwiązywanym w czasie ładowania i wywołania.

**Co wygrywa przy konflikcie.** Flaga CLI wygrywa z plikiem dla tego jednego uruchomienia i nie jest zapisywana. Plik wygrywa z domyślną wartością. Domyślna wartość ma dwa domy: \`.default()\` w schemacie (\`compactionFormat\`, \`codebase.*\`, \`hooks.*.timeout_ms\`, \`feedRejectionsToPlanner\`) albo \`??\` w akcesorze (\`approve\`, \`endChecks\`, \`approveChecks\`, \`isolation\`, \`idleWarnMs\`, \`validation.timeoutMs\`). Dla \`contextLength\` implementera kolejność jest: env → config → wykrycie z endpointu → katalog modelu → 32768.

**Liczby.** Lista poniżej ma 170 wpisów: 65 wpisów \`config.yaml\` (klucze, pola per kind i pola wycofane), 26 wpisów flag CLI (46 opcji workflow na \`start\`/\`resume\`/\`continue\`, zgrupowanych per seat, plus opcje \`init\`, \`doctor\`, \`review\`, \`spec\`, \`status\` i flagi globalne), 23 wpisy zmiennych środowiskowych, 15 plików ustawień poza \`config.yaml\` i 41 stałych działających jak ukryta konfiguracja. 35 wpisów nie było wcześniej w żadnym obszarze atlasu (\`inAtlasBefore: false\`): 4 z \`config.yaml\`, 1 flaga, 8 zmiennych, 5 plików, 17 stałych.

**Czego brakowało w atlasie przed tym obszarem.** Z \`config.yaml\`: \`customCommands\` (tylko wzmianka), \`workflow.showSpend\`, \`sessions.scope\`, \`workflow.git.commitStrategy\`, pola profilu \`label\` i \`capabilities.writesFiles\` (tylko wzmianki), wpisy hooka \`kind\`/\`name\`, reguła \`idleKillMs >= idleWarnMs\`, konflikt \`outputFormat\` na narzędziach z protokołem terminalnym, reguły \`apiKey\` dla providera własnego i Ollamy. Ze środowiska: \`SPLITBRIEF_REDUCE_MOTION\`, \`COLORFGBG\`, \`TERM\`/\`LANG\` (poziom glifów), \`TMUX\`/\`STY\`/\`SSH_CONNECTION\` (schowek), \`PATH\`/\`PATHEXT\`, lista \`GIT_*\`, polityka środowiska dziecka (\`createCommandEnv\`), \`XDG_CACHE_HOME\`/\`LOCALAPPDATA\`. Z plików: \`~/.splitbrief/history\`, \`~/.splitbrief/cache/models-dev-catalog-*.json\`, \`.splitbrief/detection-cache.json\`, \`~/.splitbrief/trust/custom-runners.json\`, katalogi skilli. Ze stałych: \`SIGKILL_DELAY_MS\`, \`CAPTURE_LIMITS\`, \`HALT_TAIL_LINES\`, \`VERDICT_RULES\`, \`HAND_BACK_*\`, \`TRUST_STORE_MAX_*\`, timeouty sond i wykrywania, \`MAX_INPUT_HISTORY\`, \`toolUseCountLimit\`, \`consultDiffChars\`.`,
  entry: [
    'src/core/config/load/io.ts:145',
    'src/core/config/runtime/effective-config.ts:59',
    'src/cli/options.ts:209',
    'src/engine/providers/capabilities.ts:46'
  ],
  links: [
    { to: 'startup', label: 'loadConfig i resolveEffectiveConfig działają w bootstrapie; readiness czyta klucze workflow i validation' },
    { to: 'runners', label: 'bloki planner / implementer / reviewer i ich pola per kind budują seaty' },
    { to: 'planning', label: 'codebase.*, validation.render, hooks.pre_planning i wycofane klucze workflow decydują o sesji planowania' },
    { to: 'build', label: 'workflow.review, isolation, approval.allowedPaths, BOUNDS i TIMEOUTS sterują pętlą briefów' },
    { to: 'review', label: 'validation.end_checks, approve_checks, timeout_ms, render i stałe review' },
    { to: 'recovery', label: '<seat>.fallback, --on-seat-down, BOUNDS.rateLimitResetWaitMs i transientRetries' },
    { to: 'lifecycle', label: 'XDG_STATE_HOME, lockfile.json, draft.json i compactionThreshold' },
    { to: 'ui', label: 'ui-prefs.json, palette.customActions, VISUAL / EDITOR / PAGER, FORCE_HYPERLINK' },
    { to: 'subsystems', label: 'hooks.*, codebase.*, SPLITBRIEF_DEBUG, logi i cache' }
  ],
  diagrams: [
    {
      id: 'configuration-load',
      title: 'Ładowanie config.yaml i pierwszeństwo: plik → domyślne → flagi → env',
      caption: 'Od odczytu pliku do konfiguracji efektywnej. Każdy romb to decyzja loadera albo walidatora; po prawej stronie widać, gdzie wchodzą domyślne wartości, flagi CLI i jedyna zmienna środowiskowa, która nadpisuje plik.',
      mermaid: `flowchart TD
  A["splitbrief start / resume / continue / init / doctor"] --> B["readConfigDocument(projectDir)<br/>otwiera .splitbrief/config.yaml z O_NOFOLLOW"]
  B --> CF_FILE_PRESENT{"Plik istnieje?"}
  CF_FILE_PRESENT -->|"nie"| D["createDefaultConfig()<br/>planner claude-code, implementer Ollama qwen3-coder:30b<br/>bez ostrzeżeń"]
  CF_FILE_PRESENT -->|"tak"| E["YAML.parse(rawYaml)"]
  E --> CF_YAML_PARSES{"Poprawny YAML i obiekt?"}
  CF_YAML_PARSES -->|"nie"| F["configError.invalidYaml albo<br/>'must be a YAML object' → exit 1"]
  CF_YAML_PARSES -->|"tak"| G["fromYaml: snake_case → camelCase<br/>hooks.<event> zostają w snake_case"]
  G --> CF_KEY_SPELLING{"Jeden klucz w dwu pisowniach?"}
  CF_KEY_SPELLING -->|"tak"| G2["późniejsza linia wygrywa"]
  CF_KEY_SPELLING -->|"nie"| H
  G2 --> H["camelRecord"]
  H --> CF_VERSION{"version === 3?"}
  CF_VERSION -->|"nie / brak"| I["configError.unsupportedVersion → exit 1<br/>'Supported: 3'"]
  CF_VERSION -->|"tak"| J["mergeWithDefaults"]
  J --> CF_MERGE_DEFAULTS{"Blok implementer ma inny kind<br/>albo inny provider niż Ollama?"}
  CF_MERGE_DEFAULTS -->|"tak"| K["blok zostaje jak w pliku<br/>brak dopisanych pól"]
  CF_MERGE_DEFAULTS -->|"nie"| L["dopisane: provider, service, offering,<br/>apiBase, model, temperature 0.3"]
  K --> M["validateConfig: ConfigSchema.safeParse<br/>+ removedEntityErrors + removedTopLevelKeyErrors<br/>+ outputFormatConflictErrors + apiKeyErrors"]
  L --> M
  M --> CF_REMOVED_KEY{"Usunięty klucz główny, kind agent-sdk,<br/>provider z REMOVED_API_PROVIDER_IDS, tool aider?"}
  CF_REMOVED_KEY -->|"tak"| N["błąd z nazwą ścieżki → exit 1"]
  CF_REMOVED_KEY -->|"nie"| CF_KEY_KNOWN{"Nieznany klucz?"}
  CF_KEY_KNOWN -->|"w bloku strict"| O["'Unknown config key' pod pełną ścieżką → exit 1"]
  CF_KEY_KNOWN -->|"na korzeniu"| P["tolerowany, ignorowany"]
  CF_KEY_KNOWN -->|"nie"| CF_RETIRED_VALUE{"Klucz wycofany<br/>(RETIRED_CONFIG_VALUES)?"}
  P --> CF_RETIRED_VALUE
  CF_RETIRED_VALUE -->|"tak"| Q["ładuje się, jedna notice na klucz<br/>approve all/spec/default → plan"]
  CF_RETIRED_VALUE -->|"nie"| R["Config (Zod data)"]
  Q --> R
  R --> S["resolveEffectiveConfig: applyCLIOverrides"]
  S --> CF_CLI_OVERRIDE{"Flaga --<seat>-* podana?"}
  CF_CLI_OVERRIDE -->|"tak"| T["buildRunnerConfig nadpisuje seat<br/>tylko na to uruchomienie"]
  CF_CLI_OVERRIDE -->|"nie"| U["seat z pliku"]
  T --> CF_EFFECTIVE_VALID{"validateConfig(effective) bez błędów?"}
  U --> CF_EFFECTIVE_VALID
  CF_EFFECTIVE_VALID -->|"nie"| V["configError.validationFailed('effective config')"]
  CF_EFFECTIVE_VALID -->|"tak"| W["konfiguracja efektywna + ostrzeżenia<br/>(uprawnienia pliku, retired, {prompt} w argv)"]
  W --> CF_ENV_CONTEXT{"SPLITBRIEF_CONTEXT_LENGTH ustawione?"}
  CF_ENV_CONTEXT -->|"tak"| X["contextLength = env (origin 'env')"]
  CF_ENV_CONTEXT -->|"nie"| Y["implementer.contextLength → wykrycie → katalog → 32768"]`
    },
    {
      id: 'configuration-seat-validation',
      title: 'Walidacja bloku seatu: kind, poświadczenia, fallback, watchdog, flagi',
      caption: 'Decyzje, które dotyczą jednego bloku planner / implementer / reviewer / profilu. Każda gałąź „błąd” kończy ładowanie z nazwą ścieżki; każda „ostrzeżenie” pozwala wystartować.',
      mermaid: `flowchart TD
  A["blok seatu (planner / implementer / reviewer / implementerProfiles.profiles.<name>)"] --> B["discriminatedUnion('kind')"]
  B --> CF_OUTPUT_FORMAT_CONFLICT{"kind cli, outputFormat ustawione,<br/>tool w STRUCTURED_TERMINAL_TOOL_IDS?"}
  CF_OUTPUT_FORMAT_CONFLICT -->|"tak"| C["błąd: 'cannot replace the <tool> terminal contract'"]
  CF_OUTPUT_FORMAT_CONFLICT -->|"nie"| CF_IDLE_ORDER{"idleKillMs < idleWarnMs<br/>(albo < 300000 gdy warn nie ustawiony)?"}
  CF_IDLE_ORDER -->|"tak"| D["błąd pod idleKillMs"]
  CF_IDLE_ORDER -->|"nie"| CF_CREDENTIAL{"kind api: jakie źródło klucza?"}
  CF_CREDENTIAL -->|"env:VAR nieustawiony"| E["błąd 'Environment variable VAR is not set'"]
  CF_CREDENTIAL -->|"provider własny z env:VAR"| F["błąd 'API key exfiltration risk'"]
  CF_CREDENTIAL -->|"ollama z kluczem innym niż env:OLLAMA_LOCAL_API_KEY"| G["błąd pod apiKey"]
  CF_CREDENTIAL -->|"provider zdalny z katalogu, brak klucza i env"| H["błąd '<provider> requires apiKey or ENV'"]
  CF_CREDENTIAL -->|"ok / kind nie api"| CF_FALLBACK_VALID{"fallback zadeklarowany?"}
  CF_FALLBACK_VALID -->|"tak, nie przechodzi schematu cli seatu"| I["błąd pod fallback.<pole>"]
  CF_FALLBACK_VALID -->|"tak, effort na narzędziu kanału variant"| J["błąd: 'set fallback.variant instead'"]
  CF_FALLBACK_VALID -->|"nie / ok"| K["blok przyjęty"]
  K --> CF_REVIEWER_EFFORT{"--reviewer-effort, a REVIEW = PLAN?"}
  CF_REVIEWER_EFFORT -->|"tak"| L["błąd invalidOverride:<br/>'pass --reviewer to give it its own runner first'"]
  CF_REVIEWER_EFFORT -->|"nie"| M["effort nałożony na reviewer albo brak flagi"]
  M --> CF_SEAT_DOWN_POLICY{"headless: --on-seat-down?"}
  CF_SEAT_DOWN_POLICY -->|"switch, a żaden seat nie ma fallback"| N["cliError exit 2"]
  CF_SEAT_DOWN_POLICY -->|"halt"| O["Seat down zatrzymuje run, brak przełączenia"]
  CF_SEAT_DOWN_POLICY -->|"switch / brak flagi"| P["zadeklarowany fallback stosowany raz na run i seat"]`
    },
    {
      id: 'configuration-groups-map',
      title: 'Grupy konfiguracji → obszary atlasu, które je czytają',
      caption: 'Lewa kolumna to grupy kluczy, prawa to obszary. Krawędź oznacza: ten obszar opisuje przepływ, w którym ta grupa zmienia zachowanie.',
      mermaid: `flowchart LR
  subgraph CFG["config.yaml"]
    SEATS["planner / implementer / reviewer<br/>implementerProfiles, customCommands"]
    WF["workflow.*"]
    VAL["validation.*"]
    HOOKS["hooks.*"]
    CB["codebase.*"]
    APR["approval.*"]
    PAL["palette.*"]
  end
  subgraph FLAGS["flagi CLI"]
    SEATFLAGS["--planner* --implementer* --reviewer*<br/>--model --provider --*-effort"]
    MODE["--json --plain --on-seat-down<br/>--allow-* --skills --action"]
    TUI["--no-fullscreen --no-mouse --hover --project"]
  end
  subgraph ENV["środowisko"]
    KEYS["ANTHROPIC_API_KEY, OPENAI_API_KEY,<br/>COPILOT_GITHUB_TOKEN, CURSOR_API_KEY, *_API_KEY"]
    DBG["SPLITBRIEF_DEBUG, SPLITBRIEF_DEBUG_KEYS,<br/>SPLITBRIEF_CONTEXT_LENGTH"]
    TERM["CI, FORCE_HYPERLINK, VISUAL/EDITOR/PAGER,<br/>COLORFGBG, TERM, XDG_*"]
  end
  subgraph FILES["pliki ustawień"]
    UIP["ui-prefs.json, draft.json, history"]
    TRUST["~/.splitbrief/trust/*.json"]
    CACHE["detection-cache.json, repomap.sqlite,<br/>models-dev cache"]
  end
  SEATS --> runners["runners"]
  SEATFLAGS --> runners
  KEYS --> runners
  DBG --> runners
  SEATS --> startup["startup"]
  TUI --> startup
  MODE --> startup
  TRUST --> startup
  CACHE --> startup
  WF --> planning["planning"]
  CB --> planning
  HOOKS --> planning
  WF --> build["build"]
  VAL --> build
  APR --> build
  HOOKS --> build
  VAL --> review["review"]
  WF --> review
  SEATS --> recovery["recovery"]
  MODE --> recovery
  WF --> lifecycle["lifecycle"]
  TERM --> lifecycle
  UIP --> lifecycle
  PAL --> ui["ui"]
  TERM --> ui
  UIP --> ui
  HOOKS --> subsystems["subsystems"]
  CB --> subsystems
  DBG --> subsystems
  CACHE --> subsystems`
    }
  ],
  decisions: [
    {
      id: 'CF_FILE_PRESENT',
      title: 'Czy .splitbrief/config.yaml istnieje',
      question: 'Czy w katalogu projektu jest plik konfiguracji do odczytu?',
      where: 'src/core/config/load/io.ts:147',
      inputs: ['readConfigDocument(projectDir).revision', 'realpath katalogu .splitbrief (symlink odrzucany)'],
      branches: [
        { if: 'revision === null (ENOENT pliku albo katalogu)', then: 'config = createDefaultConfig(); warnings = []; nic nie jest zapisywane na dysk', next: 'CF_EFFECTIVE_VALID' },
        { if: 'plik jest symlinkiem (ELOOP) albo katalog .splitbrief jest symlinkiem', then: 'pathConfinementError → exit 1', next: 'startup' },
        { if: 'plik istnieje', then: 'parseLoadedConfig', next: 'CF_YAML_PARSES' }
      ],
      default: 'Plik istnieje i jest czytany przez deskryptor otwarty z O_NOFOLLOW.',
      notes: 'Domyślna konfiguracja to planner claude-code (kind cli) i implementer Ollama (kind api, model qwen3-coder:30b, temperature 0.3). Pierwszy zapis pliku dopisuje .splitbrief/ do .gitignore (ensureConfigGitignore, document.ts:46).'
    },
    {
      id: 'CF_YAML_PARSES',
      title: 'Czy plik jest poprawnym YAML-em z obiektem na korzeniu',
      question: 'Czy YAML.parse zwraca obiekt, a nie błąd, listę albo skalar?',
      where: 'src/core/config/load/io.ts:100',
      inputs: ['rawYaml'],
      branches: [
        { if: 'YAML.parse rzuca', then: 'configError.invalidYaml(filePath, err) → exit 1', next: 'startup' },
        { if: 'wynik nie jest obiektem albo jest tablicą', then: "validationFailed: 'Configuration in .splitbrief/config.yaml must be a YAML object.'", next: 'startup' },
        { if: 'obiekt', then: 'fromYaml przepisuje klucze', next: 'CF_KEY_SPELLING' }
      ],
      default: 'Obiekt idzie do transformacji kluczy.'
    },
    {
      id: 'CF_KEY_SPELLING',
      title: 'snake_case czy camelCase, i co z duplikatem',
      question: 'W jakiej pisowni loader czyta klucz i która linia wygrywa, gdy mapa ma obie?',
      where: 'src/core/config/load/transform.ts:53',
      inputs: ['klucz YAML', 'ścieżka rodzica (hooks traktowane osobno)'],
      branches: [
        { if: 'ścieżka zaczyna się od hooks i klucz jest nazwą zdarzenia (pre_task, on_halt…)', then: 'klucz zostaje w snake_case (HOOK_EVENTS)', next: 'CF_VERSION' },
        { if: 'każdy inny klucz', then: 'snakeToCamel: output_format → outputFormat, end_checks → endChecks', next: 'CF_VERSION' },
        { if: 'mapa ma output_format i outputFormat', then: 'późniejsza linia wygrywa; zapis z TUI edytuje tę pisownię i usuwa wcześniejszego bliźniaka (resolveEditPath, document.ts:155)', next: 'CF_VERSION' }
      ],
      default: 'Nowy klucz zapisany z TUI dostaje pisownię snake_case (toYaml).'
    },
    {
      id: 'CF_VERSION',
      title: 'Sprawdzenie version',
      question: 'Czy camelRecord.version jest równe CONFIG_VERSION (3)?',
      where: 'src/core/config/load/io.ts:113',
      inputs: ['camelRecord.version'],
      branches: [
        { if: 'wartość różna od 3 albo brak klucza', then: "configError.unsupportedVersion: 'Unsupported config version: <v>. Supported: 3.' → exit 1; naprawa: splitbrief init --reconfigure", next: 'startup' },
        { if: '3', then: 'mergeWithDefaults', next: 'CF_MERGE_DEFAULTS' }
      ],
      default: 'Nie ma migracji w pamięci; stary plik trzeba przepisać.'
    },
    {
      id: 'CF_MERGE_DEFAULTS',
      title: 'Które domyślne wartości loader dopisuje',
      question: 'Co mergeWithDefaults dokłada do surowego rekordu przed walidacją?',
      where: 'src/core/config/load/defaults.ts:60',
      inputs: ['loaded.planner', 'loaded.implementer.kind / provider', 'loaded.validation', 'loaded.workflow'],
      branches: [
        { if: 'brak planner', then: 'planner = { kind: cli, tool: claude-code }', next: 'CF_REMOVED_KEY' },
        { if: 'brak implementer', then: 'implementer = Ollama: provider ollama, service ollama, offering local, apiBase http://localhost:11434/v1, model qwen3-coder:30b, temperature 0.3', next: 'CF_REMOVED_KEY' },
        { if: 'implementer ma kind inny niż api albo provider inny niż ollama', then: 'blok zostaje bez dopisków (mergeRunner, defaults.ts:43-47); brakujące model/apiBase wyjdą jako błędy schematu', next: 'CF_REMOVED_KEY' },
        { if: 'implementer api/ollama z brakującymi polami', then: 'dopisane tylko brakujące pola Ollamy', next: 'CF_REMOVED_KEY' },
        { if: 'validation / workflow obecne', then: 'płytkie scalenie z { endChecks: true } i { approve: plan, review: end, compactionFormat: auto }', next: 'CF_REMOVED_KEY' }
      ],
      default: 'Każdy inny klucz główny przechodzi bez zmian (passthrough bez prototypu). Bloki planner, reviewer i profile nie dostają żadnych domyślnych pól.'
    },
    {
      id: 'CF_REMOVED_KEY',
      title: 'Usunięte klucze, kinds, providery i narzędzia',
      question: 'Czy plik nazywa coś, co ta wersja usunęła i czego schemat sam by nie nazwał?',
      where: 'src/core/config/load/validation/config.ts:200',
      inputs: ['klucze główne', 'kind każdego bloku runnera', 'provider bloku api', 'tool bloku cli'],
      branches: [
        { if: 'otel, snapshots, trust, plannerEstimateReview, autoSplitOverflow, compiler na korzeniu', then: "błąd 'Unknown config key' pod nazwą klucza (compiler ma własny tekst) — mimo że korzeń nie jest strict (REMOVED_TOP_LEVEL_KEYS, :95)", next: 'startup' },
        { if: 'kind: agent-sdk w planner / reviewer / implementer / profilu', then: "'Runner kind \"agent-sdk\" was removed; use kind cli, api, shell, or agent.' (:28)", next: 'startup' },
        { if: 'provider z REMOVED_API_PROVIDER_IDS (anthropic, deepseek, groq, ollama-cloud, openai, openrouter, together)', then: "'API provider \"<id>\" was removed; only \"ollama\", \"lm-studio\", \"llama-cpp\" are built in…' (runner-fields.ts:222)", next: 'startup' },
        { if: 'tool: aider', then: "'CLI tool \"aider\" was removed; supported tools are …' (runner-fields.ts:58)", next: 'startup' },
        { if: 'nic z powyższych', then: 'dalej do nieznanych kluczy', next: 'CF_KEY_KNOWN' }
      ],
      default: 'Wszystkie błędy jednego ładowania są zbierane i wypisywane razem, jedna linia na ścieżkę.'
    },
    {
      id: 'CF_KEY_KNOWN',
      title: 'Nieznany klucz: strict czy tolerowany',
      question: 'Czy nieznany klucz leży w bloku strictObject, czy na korzeniu z.object?',
      where: 'src/core/config/load/validation/config.ts:18',
      inputs: ['issue.code === unrecognized_keys', 'ścieżka bloku'],
      branches: [
        { if: 'klucz w workflow, workflow.git, approval, hooks, codebase, każdym bloku runnera, fallback, capabilities, customCommands.<id>', then: "jeden błąd na klucz: '<blok>.<klucz>: Unknown config key — remove it or use the current spelling…' → exit 1", next: 'startup' },
        { if: 'klucz na korzeniu (ConfigSchema to z.object) albo w validation, sessions, palette, implementerProfiles (z.object)', then: 'tolerowany i ignorowany, bez ostrzeżenia', next: 'CF_RETIRED_VALUE' }
      ],
      default: 'Zod zgłasza nieznane klucze pod ścieżką obiektu; issueErrors rozwija je do pełnej ścieżki, by błąd nazwał workflow.autoApproveSpec, a nie workflow.',
      notes: 'validation, sessions, palette i implementerProfiles są z.object, więc literówka w nich (np. validation.end_check) przechodzi bez słowa. Dokumentacja §15 wymienia tylko strict bloki, nie te tolerowane.'
    },
    {
      id: 'CF_RETIRED_VALUE',
      title: 'Klucz wycofany: ładuje się z notice',
      question: 'Czy surowy rekord nazywa klucz z RETIRED_CONFIG_VALUES?',
      where: 'src/core/config/load/validation/config.ts:191',
      inputs: ['merged (rekord po scaleniu z domyślnymi)', 'RETIRED_CONFIG_VALUES'],
      branches: [
        { if: 'workflow.mode, taskReview, briefReview, speckit, driftChainThreshold, maxRetries (dowolna wartość)', then: "notice '<klucz> was retired and is ignored… Delete <klucz>.'; schemat trzyma z.unknown()", next: 'CF_EFFECTIVE_VALID' },
        { if: 'workflow.approve: all / spec / default', then: "ApproveLevelSchema (enums.ts:202) zamienia na plan; notice 'workflow.approve \"<v>\" was retired; using \"plan\"…'", next: 'CF_EFFECTIVE_VALID' },
        { if: 'approval.tiers, approval.enabled', then: 'notice; zapis do chronionych ścieżek i tak pyta', next: 'CF_EFFECTIVE_VALID' },
        { if: 'validation.typecheck, lint, test, typecheckCommand, lintCommand', then: 'notice; reviewer sam wybiera komendy, validation.end_checks włącza je', next: 'CF_EFFECTIVE_VALID' },
        { if: 'escalation (cały blok)', then: 'notice; konsultacja planera zastępuje tier pośredni', next: 'CF_EFFECTIVE_VALID' },
        { if: 'workflow.git.commitStrategy: none', then: 'bez notice: superRefine przepuszcza, transform usuwa pole (config.ts:35-44)', next: 'CF_EFFECTIVE_VALID' },
        { if: 'workflow.git.commitStrategy: checkpoint / per-task', then: "błąd 'commitStrategy \"<v>\" was removed…' → exit 1", next: 'startup' },
        { if: 'hooks.pre_commit / post_commit z wpisami', then: "błąd '<event> hooks were removed…'; pusta lista ładuje się i jest usuwana (hooks.ts:372)", next: 'startup' }
      ],
      default: 'Notice są raportowane raz na proces i projekt (emitEffectiveConfigWarnings, effective-config.ts:47) i trafiają do raportu readiness.'
    },
    {
      id: 'CF_OUTPUT_FORMAT_CONFLICT',
      title: 'outputFormat na narzędziu z protokołem terminalnym',
      question: 'Czy blok cli ustawia outputFormat dla narzędzia, którego parser natywny jest kontraktem?',
      where: 'src/core/config/load/validation/config.ts:72',
      inputs: ['runner.kind === cli', 'runner.tool ∈ STRUCTURED_TERMINAL_TOOL_IDS (antigravity, claude-code, codex, command-code, cursor)', 'runner.outputFormat'],
      branches: [
        { if: 'tool w liście i outputFormat ustawione', then: "błąd '<path>.outputFormat: Configured outputFormat cannot replace the <tool> terminal contract…' przy ładowaniu", next: 'startup' },
        { if: 'opencode, copilot, kilo-code albo kind shell/agent', then: 'outputFormat przyjęte: stream-json | jsonl | text | opencode', next: 'CF_IDLE_ORDER' }
      ],
      default: 'Bez outputFormat parser adaptera.',
      notes: 'Dokumentacja (CONFIGURATION.md §2 kind: cli) pisze, że odmowa następuje „before spawn”; kod odrzuca już przy ładowaniu, a adapter ma drugą blokadę (output-format.ts).'
    },
    {
      id: 'CF_IDLE_ORDER',
      title: 'Kolejność progów watchdoga',
      question: 'Czy idleKillMs jest co najmniej równe efektywnemu idleWarnMs?',
      where: 'src/core/schemas/runner-fields.ts:99',
      inputs: ['idleWarnMs (albo RUNNER_IDLE_WARN_MS 300000, gdy brak)', 'idleKillMs'],
      branches: [
        { if: 'idleKillMs nieustawione', then: 'poprawne: brak cięcia, dowolny idleWarnMs', next: 'CF_CREDENTIAL' },
        { if: 'idleKillMs < efektywny warn', then: "błąd 'idleKillMs must be at least idleWarnMs (the warning fires before the kill); an unset idleWarnMs takes its default (300000)'", next: 'startup' },
        { if: 'idleKillMs >= warn', then: 'przyjęte; customCommands ma tę samą regułę (custom-commands.ts:76)', next: 'CF_CREDENTIAL' }
      ],
      default: 'Blok api nie ma tych pól (strict odrzuca je); api ma własne deadline: 120 s do pierwszej odpowiedzi, 60 s ciszy strumienia, suma 20/10 min.'
    },
    {
      id: 'CF_CREDENTIAL',
      title: 'Źródło apiKey dla bloku api',
      question: 'Skąd pochodzi klucz API i czy ten kształt jest dozwolony dla tego providera?',
      where: 'src/core/config/load/validation/credentials.ts:40',
      inputs: ['config.provider (katalog: ollama, lm-studio, llama-cpp; inaczej provider własny)', 'config.apiKey (inline albo env:VAR)', 'process.env[VAR]', 'config.apiBase'],
      branches: [
        { if: 'apiKey: env:VAR, a VAR nie jest w środowisku', then: "błąd 'Environment variable VAR is not set (referenced by <path>.apiKey).' (credentials.ts:23)", next: 'startup' },
        { if: 'provider własny (poza katalogiem) bez apiKey', then: "błąd 'Custom provider <id> <role> requires <path>.apiKey' (runner-credentials.ts:21)", next: 'startup' },
        { if: 'provider własny z apiKey: env:VAR', then: "błąd '…cannot use env apiKey reference env:VAR with apiBase … (API key exfiltration risk)' (credentials.ts:59)", next: 'startup' },
        { if: 'provider z katalogu z własnym apiBase na innym originie, env ustawiony, brak inline klucza', then: "błąd 'cannot use <ENV> without an inline apiKey' (credentials.ts:33)", next: 'startup' },
        { if: 'provider ollama z apiKey innym niż env:OLLAMA_LOCAL_API_KEY', then: "błąd 'Local Ollama apiKey must be omitted or exactly \"env:OLLAMA_LOCAL_API_KEY\"' (runner-fields.ts:205)", next: 'startup' },
        { if: 'apiBase nie przechodzi validateApiBaseUrl', then: "błąd pod <path>.apiBase z diagnosticState 'endpoint-invalid'", next: 'startup' },
        { if: 'provider lokalny bez klucza', then: 'poprawne: isLocal pomija wymóg', next: 'CF_FALLBACK_VALID' }
      ],
      default: 'Klucz inline jest wysyłany tylko do znormalizowanego originu apiBase, wyłącznie w nagłówku Authorization.'
    },
    {
      id: 'CF_FALLBACK_VALID',
      title: 'Walidacja fallback seatu',
      question: 'Czy zadeklarowany fallback jest runnerem cli, który ten seat może hostować?',
      where: 'src/core/schemas/runner-fields.ts:327',
      inputs: ['runner.fallback { tool, model?, effort?, variant? }', 'schemat cli tego seatu (rola planner / implementer)', 'CLI_TOOL_CATALOG[tool].effortChannel'],
      branches: [
        { if: 'brak fallback', then: 'seat bez fallbacku: halt pyta użytkownika (none · pause and ask)', next: 'recovery' },
        { if: 'cliSeat.safeParse({ kind: cli, ...fallback }) nie przechodzi', then: "każdy issue pod ścieżką fallback.<pole> z prefiksem 'fallback '", next: 'startup' },
        { if: 'fallback.effort ustawione, a narzędzie ma kanał variant (opencode, kilo-code)', then: "błąd 'fallback tool \"<tool>\" takes its effort as a variant; set fallback.variant instead'", next: 'startup' },
        { if: 'poprawny', then: 'jedno automatyczne przełączenie na run i seat przy odmowie konta albo długim resecie', next: 'recovery' }
      ],
      default: 'FallbackRunnerSchema jest strict: tylko tool, model, effort, variant.'
    },
    {
      id: 'CF_CLI_OVERRIDE',
      title: 'Czy flaga CLI nadpisuje seat z pliku',
      question: 'Które flagi --<seat>-* faktycznie zmieniają blok runnera, a które są ignorowane z ostrzeżeniem?',
      where: 'src/core/config/runtime/overrides/runner.ts:141',
      inputs: ['overrides: tool, model, command, apiBase, apiKey, args, outputFormat, contextLength', 'istniejący blok', 'inferKindFromTool(tool)'],
      branches: [
        { if: 'tool podany', then: 'kind z nazwy: shell / agent / id z CLI_TOOL_IDS → cli / inaczej api; identyfikator CLI zawsze wybiera CLI (build-runner.ts:250)', next: 'CF_EFFECTIVE_VALID' },
        { if: 'command podany bez tool', then: 'kind shell', next: 'CF_EFFECTIVE_VALID' },
        { if: 'apiBase / apiKey podane, a kind docelowy nie jest api', then: "flaga ignorowana: stderr '--<role>-api-key-env is ignored: …' (warnUnusableProviderOverrides :97)", next: 'CF_EFFECTIVE_VALID' },
        { if: 'żadna z: tool, model, command, args, outputFormat, contextLength ani (apiBase/apiKey przy api)', then: 'blok z pliku bez zmian', next: 'CF_EFFECTIVE_VALID' },
        { if: 'implementerProfiles istnieje', then: 'nadpisanie trafia do profilu domyślnego i lustra implementer (applyImplementerOverrides :184)', next: 'CF_EFFECTIVE_VALID' },
        { if: '--planner-effort / --reviewer-effort', then: 'parse EffortLevelSchema; zła wartość → invalidOverride z listą (apply.ts:46)', next: 'CF_REVIEWER_EFFORT' }
      ],
      default: 'Zmiana celu (inny tool/provider) kasuje effort i variant, zachowuje timeout i fallback (build-runner.ts:150, :229).'
    },
    {
      id: 'CF_REVIEWER_EFFORT',
      title: '--reviewer-effort przy odziedziczonym REVIEW',
      question: 'Czy seat REVIEW ma własny blok, na który można nałożyć effort?',
      where: 'src/core/config/runtime/overrides/runner.ts:215',
      inputs: ['resolveReviewerRunner(config).source'],
      branches: [
        { if: "source === 'planner' (brak bloku reviewer i brak --reviewer)", then: "configError.invalidOverride('--reviewer-effort', …, 'The review seat inherits the planner; pass --reviewer to give it its own runner first.') → exit 1", next: 'startup' },
        { if: "source === 'configured'", then: 'reviewer = { ...runner, effort }', next: 'CF_EFFECTIVE_VALID' }
      ],
      default: 'Ta sama zasada blokuje applyEdits na ścieżce reviewer.* w Settings (values.ts:24: configError.reviewerInherited).'
    },
    {
      id: 'CF_EFFECTIVE_VALID',
      title: 'Druga walidacja: konfiguracja efektywna',
      question: 'Czy konfiguracja po nałożeniu flag nadal przechodzi validateConfig?',
      where: 'src/core/config/runtime/effective-config.ts:64',
      inputs: ['applyCLIOverrides(base, overrides)', 'loaderDiagnostics z loadConfig'],
      branches: [
        { if: 'errors.length > 0', then: "configError.validationFailed('effective config', …) → exit 1; typowo brak modelu dla implementera api/shell/agent po --implementer", next: 'startup' },
        { if: 'bez błędów', then: 'EffectiveConfigResult { config, warnings: loader + validation }; ostrzeżenia idą na stderr raz na proces', next: 'CF_ENV_CONTEXT' }
      ],
      default: 'Ostrzeżenia: uprawnienia pliku (0o022), notice retired, {prompt} w argv runnera shell/agent.'
    },
    {
      id: 'CF_ENV_CONTEXT',
      title: 'Źródło contextLength implementera',
      question: 'Skąd pochodzi okno kontekstu, na którym routing mierzy brief?',
      where: 'src/engine/providers/capabilities.ts:46',
      inputs: ['process.env.SPLITBRIEF_CONTEXT_LENGTH', 'config.implementer.contextLength', 'provider.detectContextLength(model)', 'resolveRunnerContextWindow (katalog)'],
      branches: [
        { if: 'SPLITBRIEF_CONTEXT_LENGTH parsuje się jako liczba', then: "origin 'env'; tylko profil domyślny", next: 'build' },
        { if: 'implementer.contextLength ustawione', then: "origin 'config'", next: 'build' },
        { if: 'kind api i provider wykrywa okno', then: "origin 'detected'; błąd wykrycia daje warnError i idzie dalej", next: 'build' },
        { if: 'katalog modelu zna okno (api albo cli)', then: "origin 'catalog'", next: 'build' }
      ],
      default: "DEFAULT_UNKNOWN_CONTEXT_LENGTH = 32768, origin 'fallback' (context-length.ts:8). Planner i reviewer używają contextLength tylko na kind api (budżet pakietu PLAN/REVIEW)."
    },
    {
      id: 'CF_SEAT_DOWN_POLICY',
      title: 'Polityka --on-seat-down w trybie headless',
      question: 'Co run headless robi przy halcie Seat down, gdy seat deklaruje fallback?',
      where: 'src/cli/headless.ts:365',
      inputs: ['options.onSeatDown (halt | switch | brak)', 'configDeclaresFallback(config)', 'pendingRecovery.switchSeat.auto'],
      branches: [
        { if: "'switch' i żaden seat nie deklaruje fallback", then: "cliError('`--on-seat-down switch` needs a seat that declares `fallback`…', 2) przed startem", next: 'startup' },
        { if: "'halt'", then: 'intencja auto-swap nie jest wykonywana; run kończy się z recovery_required', next: 'recovery' },
        { if: "'switch' albo brak flagi", then: 'applyOfferedSeatSwap wykonuje zadeklarowany fallback (raz na run i seat) i wznawia', next: 'recovery' }
      ],
      default: 'Brak flagi działa jak switch, czyli jak TUI: zadeklarowana intencja jest stosowana.'
    }
  ],
  config: [
    { key: 'version', values: 'literal 3', default: 'wymagane', effect: 'Jedyna przyjmowana wersja schematu. Inna wartość albo brak kończy ładowanie błędem config-unsupported-version.', where: 'src/core/schemas/config.ts:58; src/core/config/load/io.ts:113', group: 'config.yaml', usedBy: ['startup', 'journey'], inAtlasBefore: true },
    { key: 'planner', values: 'blok runnera: kind cli | api | shell | agent', default: '{ kind: cli, tool: claude-code } gdy brak bloku', effect: 'Seat PLAN; bez bloku reviewer trzyma też seat REVIEW. Pola per kind niżej.', where: 'src/core/schemas/planner-config.ts:8; src/core/config/load/defaults.ts:11', group: 'config.yaml', usedBy: ['runners', 'planning', 'startup'], inAtlasBefore: true },
    { key: 'implementer', values: 'blok runnera: kind cli | api | shell | agent', default: 'Ollama: kind api, provider ollama, service ollama, offering local, apiBase http://localhost:11434/v1, model qwen3-coder:30b, temperature 0.3', effect: 'Seat BUILD. Loader dopisuje brakujące pola Ollamy tylko gdy kind to api (lub brak) i provider to ollama (lub brak).', where: 'src/core/schemas/implementer-config.ts:5; src/core/config/load/defaults.ts:15; src/core/config/load/defaults.ts:39', group: 'config.yaml', usedBy: ['runners', 'build', 'startup'], inAtlasBefore: true },
    { key: 'reviewer', values: 'blok runnera (opcjonalny), ten sam schemat co planner z rolą reviewer', default: 'brak: REVIEW = PLAN', effect: 'Własny seat REVIEW. resolveReviewerRunner jest jedynym modułem, który rozgałęzia się na config.reviewer. Przy braku bloku --reviewer-effort i edycja reviewer.* w Settings są odrzucane.', where: 'src/core/schemas/reviewer-config.ts:8; src/core/config/accessors/reviewer-runner.ts:9', group: 'config.yaml', usedBy: ['runners', 'review'], inAtlasBefore: true },
    { key: 'implementerProfiles.default', values: 'nazwa profilu [a-z][a-z0-9-]*, max 64', default: 'pierwszy profil po sortowaniu nazw', effect: 'Który profil jest lustrem implementer i celem flag --implementer*. Nazwa spoza profiles to błąd ładowania.', where: 'src/core/schemas/implementer-config.ts:43; src/core/config/accessors/implementer-profiles.ts:19', group: 'config.yaml', usedBy: ['runners', 'build'], inAtlasBefore: true },
    { key: 'implementerProfiles.profiles.<name>', values: 'blok runnera implementera + label, capabilities', default: 'brak (jeden implementer)', effect: 'Tabela profili dla routingu kontekstu. Pusta tabela to błąd. Każdy profil przechodzi walidację poświadczeń osobno.', where: 'src/core/schemas/implementer-config.ts:44; src/core/config/load/validation/credentials.ts:90', group: 'config.yaml', usedBy: ['runners', 'build', 'recovery'], inAtlasBefore: true },
    { key: 'implementerProfiles.profiles.<name>.label', values: 'string niepusty', default: 'brak', effect: 'Etykieta profilu w pickerze i raportach; nic poza wyświetlaniem.', where: 'src/core/schemas/implementer-config.ts:25; src/core/config/accessors/implementer-profiles.ts:77', group: 'config.yaml', usedBy: ['runners'], inAtlasBefore: false },
    { key: 'implementerProfiles.profiles.<name>.capabilities.writesFiles', values: 'extracted-code | direct', default: 'extracted-code dla api/shell, direct dla cli/agent', effect: 'Deklaracja musi zgadzać się z wartością wynikającą z kind, inaczej błąd. Czyta ją routing i run-implementation (czy implementer pisze pliki sam).', where: 'src/core/schemas/implementer-config.ts:16; src/core/schemas/implementer-config.ts:31; src/engine/orchestrator/task/run-implementation.ts:78', group: 'config.yaml', usedBy: ['runners', 'build'], inAtlasBefore: true },
    { key: 'customCommands.<id>', values: 'rekord { label, contract: output | direct, executable, argv?, outputFormat?, idleWarnMs?, idleKillMs?, env? }', default: 'brak', effect: 'Nazwane runnery shell/agent do wielokrotnego użycia przez seaty. executable bez metaznaków shella, argv literalne, literał podobny do poświadczenia odrzucany, dwa wpisy o tym samym tuplu odrzucane. Żaden seat nie wskazuje dziś wpisu po id w schemacie: przestrzeń odczytuje go tylko katalog zaufania (custom-command-catalog.ts).', where: 'src/core/config/custom-commands.ts:293; src/core/config/custom-commands.ts:54; src/core/config/custom-command-catalog.ts:1', group: 'config.yaml', usedBy: ['runners', 'startup'], inAtlasBefore: true },
    { key: '<seat>.kind', values: 'cli | api | shell | agent', default: 'wymagane (dyskryminator)', effect: 'Wybiera gałąź schematu i fabrykę runnera. agent-sdk jest usunięty: błąd z nazwą ścieżki.', where: 'src/core/schemas/runner-fields.ts:405; src/core/schemas/enums.ts:250; src/core/config/load/validation/config.ts:28', group: 'config.yaml', usedBy: ['runners'], inAtlasBefore: true },
    { key: '<seat>.model', values: 'id modelu albo auto', default: 'cli i planner/reviewer: brak (= auto, model hosta); implementer api/shell/agent: wymagane', effect: 'auto na api wymaga, by provider miał domyślny model w katalogu; inaczej błąd. Na cli auto czyta wybór narzędzia z jego plików (readHostModelSelection).', where: 'src/core/schemas/runner-fields.ts:378; src/core/schemas/runner-fields.ts:417; src/core/schemas/runner-fields.ts:179', group: 'config.yaml', usedBy: ['runners'], inAtlasBefore: true },
    { key: '<seat>.customModels', values: 'string[]', default: '[]', effect: 'Dodatkowe id modeli scalane do katalogu pickera. Polityka modelu narzędzia (cliModelPolicyViolations) może je odrzucić.', where: 'src/core/schemas/runner-fields.ts:379; src/features/runners/model-catalog/catalog.ts:302', group: 'config.yaml', usedBy: ['runners', 'ui'], inAtlasBefore: true },
    { key: '<seat>.contextLength', values: 'int > 0', default: 'brak: env → wykrycie → katalog → 32768 (implementer); planner/reviewer używają tylko na api', effect: 'Budżet aplikacji dla routingu briefu i pakietów PLAN/REVIEW. Nie zmienia serwera ani num_ctx.', where: 'src/core/schemas/runner-fields.ts:380; src/engine/providers/capabilities.ts:47; src/engine/orchestrator/context-routing/context-length.ts:107', group: 'config.yaml', usedBy: ['runners', 'build', 'startup'], inAtlasBefore: true },
    { key: '<seat>.temperature', values: '0..2', default: 'brak (0.3 na dopisanym implementerze Ollama)', effect: 'Przyjmowane na każdym kind, ale nie wysyłane: api pomija pole w każdym żądaniu (polityka openai-compat), cli/shell/agent dostają ostrzeżenie na stderr.', where: 'src/core/schemas/runner-fields.ts:381; src/engine/runners/factory-gates.ts:255; src/engine/providers/openai-compat-policy.ts:102', group: 'config.yaml', usedBy: ['runners', 'ui'], inAtlasBefore: true },
    { key: '<seat>.timeout', values: 'ms > 0', default: 'cli/shell/agent: brak; api: BUILD 1 200 000, PLAN/REVIEW 600 000 (TIMEOUTS)', effect: 'Całkowity budżet jednego wywołania. Na subprocesie tylko ustawiona wartość uzbraja timer. Dwa timeouty z rzędu na jednym briefie halt runner-timeout-repeated.', where: 'src/core/schemas/runner-fields.ts:382; src/engine/runners/cli-tools/process-invoke.ts:285; src/engine/providers/api-deadlines.ts:46', group: 'config.yaml', usedBy: ['runners', 'build'], inAtlasBefore: true },
    { key: '<seat>.effort', values: 'none | minimal | low | medium | high | xhigh | max', default: 'brak', effect: 'Wskazówka wysiłku; dostarczana tylko kanałem effort-flag (claude-code, codex, copilot, command-code). Na innym kanale czyszczona w TUI albo pomijana z ostrzeżeniem.', where: 'src/core/schemas/runner-fields.ts:383; src/core/schemas/enums.ts:256; src/core/runners/effort-channel.ts:97', group: 'config.yaml', usedBy: ['runners'], inAtlasBefore: true },
    { key: '<seat>.variant', values: 'string niepusty', default: 'brak', effect: 'Preset kanału variant (opencode: sufiks #name na modelu od 2.0.0; kilo-code: --variant). Na innym narzędziu pomijany z ostrzeżeniem. Konfiguracja --variant przez args jest odrzucana przed spawn.', where: 'src/core/schemas/runner-fields.ts:384; src/engine/runners/cli-tools/opencode.ts:138', group: 'config.yaml', usedBy: ['runners'], inAtlasBefore: true },
    { key: '<seat>.fallback', values: 'strict { tool, model?, effort?, variant? }', default: 'brak (none · pause and ask)', effect: 'Runner cli, na który seat przechodzi raz na run przy odmowie konta albo resecie dłuższym niż BOUNDS.rateLimitResetWaitMs. Walidowany schematem cli tego seatu; effort na narzędziu kanału variant odrzucony.', where: 'src/core/schemas/runner-fields.ts:392; src/core/schemas/runner-fields.ts:327; src/engine/orchestrator/recovery/seat-swap-context.ts:72', group: 'config.yaml', usedBy: ['recovery', 'runners', 'ui'], inAtlasBefore: true },
    { key: '<seat>.tool (kind cli)', values: 'claude-code | codex | opencode | copilot | kilo-code | cursor | command-code | antigravity (lista per rola)', default: 'wymagane', effect: 'Adapter CLI. aider jest usunięty z własnym komunikatem. Lista planera i implementera pochodzi z katalogu (PLANNER_CLI_TOOL_IDS / IMPLEMENTER_CLI_TOOL_IDS).', where: 'src/core/schemas/runner-fields.ts:113; src/core/schemas/runner-fields.ts:122; src/core/runners/cli-tool-catalog.ts:932', group: 'config.yaml', usedBy: ['runners'], inAtlasBefore: true },
    { key: '<seat>.authChannel (kind cli)', values: 'api-key | session | provider-dependent', default: 'brak (kanał domyślny narzędzia)', effect: 'Musi być kanałem, który narzędzie deklaruje, inaczej błąd ładowania. Wybiera, które zmienne env i który stan hosta dostaje dziecko (sandbox-env).', where: 'src/core/schemas/runner-fields.ts:114; src/core/schemas/runner-fields.ts:297; src/engine/runners/sandbox-env.ts:89', group: 'config.yaml', usedBy: ['runners'], inAtlasBefore: true },
    { key: '<seat>.args (kind cli | shell | agent)', values: 'string[]', default: '[]', effect: 'Dodatkowe argv. Dla cli każdy token przechodzi preflight: flagi autorytetu (permission, sandbox, cwd, model transport, --variant) są odrzucane przed spawn. Dla shell/agent {prompt} w args daje ostrzeżenie bezpieczeństwa.', where: 'src/core/schemas/runner-fields.ts:115; src/engine/runners/arg-vector-preflight.ts:225; src/core/config/load/validation/warnings.ts:9', group: 'config.yaml', usedBy: ['runners'], inAtlasBefore: true },
    { key: '<seat>.outputFormat (kind cli | shell | agent)', values: 'stream-json | jsonl | text | opencode', default: 'parser adaptera (text dla customCommands)', effect: 'Parser stdout. Na antigravity, claude-code, codex, command-code, cursor ustawienie jest błędem ładowania (protokół terminalny jest kontraktem).', where: 'src/core/schemas/runner-fields.ts:116; src/core/schemas/enums.ts:244; src/core/config/load/validation/config.ts:72', group: 'config.yaml', usedBy: ['runners'], inAtlasBefore: true },
    { key: '<seat>.idleWarnMs (kind cli | shell | agent)', values: 'int > 0', default: '300000 (RUNNER_IDLE_WARN_MS)', effect: 'Po tej ciszy byline pokazuje ostrzeżenie; nic nie kończy. Blok api odrzuca pole.', where: 'src/core/schemas/runner-fields.ts:91; src/core/schemas/runner-fields.ts:87', group: 'config.yaml', usedBy: ['runners', 'build'], inAtlasBefore: true },
    { key: '<seat>.idleKillMs (kind cli | shell | agent)', values: 'int > 0, >= efektywny idleWarnMs', default: 'brak (bez cięcia)', effect: 'Po tej ciszy proces dostaje SIGTERM, po 2 s SIGKILL; próba liczy się jako nieudana. Dwa cięcia z rzędu na briefie to halt runner-timeout-repeated.', where: 'src/core/schemas/runner-fields.ts:92; src/core/schemas/runner-fields.ts:99; src/engine/orchestrator/escalation/local-retries.ts:65', group: 'config.yaml', usedBy: ['runners', 'build'], inAtlasBefore: true },
    { key: '<seat>.provider (kind api)', values: 'ollama | lm-studio | llama-cpp | dowolna nazwa własna', default: 'wymagane', effect: 'Nazwa z katalogu musi być dopuszczona dla roli; nazwa własna to endpoint własny. anthropic, deepseek, groq, ollama-cloud, openai, openrouter, together są usunięte z własnym komunikatem.', where: 'src/core/schemas/runner-fields.ts:134; src/core/schemas/runner-fields.ts:150; src/core/schemas/runner-fields.ts:35', group: 'config.yaml', usedBy: ['runners'], inAtlasBefore: true },
    { key: '<seat>.service (kind api)', values: 'string niepusty', default: 'wymagane (dopisane tylko dla Ollamy w implementer)', effect: 'Tożsamość rozliczeniowa. Dla providera z katalogu musi równać się jego service, inaczej błąd pod offering.', where: 'src/core/schemas/runner-fields.ts:135; src/core/schemas/runner-fields.ts:234', group: 'config.yaml', usedBy: ['runners'], inAtlasBefore: true },
    { key: '<seat>.offering (kind api)', values: 'payg | free-quota | coding-subscription | local', default: 'wymagane (local dopisane dla Ollamy w implementer)', effect: 'Dla providera z katalogu musi równać się jego offering. Decyduje o posturze rozliczeniowej w raportach.', where: 'src/core/schemas/runner-fields.ts:136; src/core/providers/api-provider-catalog.ts:5', group: 'config.yaml', usedBy: ['runners'], inAtlasBefore: true },
    { key: '<seat>.apiBase (kind api)', values: 'URL', default: 'wymagane; flagi dopisują URL z katalogu (loopback: localhost:11434 / 1234 / 8080)', effect: 'Adres endpointu. Niepoprawny URL to błąd z diagnosticState endpoint-invalid. Dla providera z katalogu origin inny niż katalogowy zmienia reguły klucza.', where: 'src/core/schemas/runner-fields.ts:137; src/core/config/api-base.ts:4; src/core/config/runtime/build-runner.ts:371', group: 'config.yaml', usedBy: ['runners'], inAtlasBefore: true },
    { key: '<seat>.apiKey (kind api)', values: 'inline | env:<VAR>', default: 'brak', effect: 'Provider własny: tylko inline (env: odrzucane). Ollama: tylko env:OLLAMA_LOCAL_API_KEY albo brak. lm-studio / llama-cpp: dowolne env:VAR. env:VAR bez wartości w środowisku to błąd ładowania. Provider zdalny z katalogu bez klucza ani zmiennej to błąd.', where: 'src/core/schemas/runner-fields.ts:138; src/core/config/credentials.ts:12; src/core/schemas/runner-fields.ts:205; src/core/config/credentials.ts:59', group: 'config.yaml', usedBy: ['runners', 'startup'], inAtlasBefore: true },
    { key: '<seat>.command (kind shell | agent)', values: 'ścieżka wykonywalna, bez {prompt}', default: 'wymagane', effect: 'Program uruchamiany bez shella; prompt idzie na stdin. Komenda nie jest zaufana przez sam plik: wymaga receiptu w ~/.splitbrief/trust/custom-runners.json albo --allow-repo-runners.', where: 'src/core/schemas/runner-fields.ts:361; src/core/schemas/runner-fields.ts:72; src/engine/runners/custom-trust.ts:21', group: 'config.yaml', usedBy: ['runners', 'startup'], inAtlasBefore: true },
    { key: '<seat>.env (kind shell | agent)', values: 'string[] nazw ^[A-Z_][A-Z0-9_]*$', default: '[]', effect: 'Jedyne zmienne z Twojego shella, które docierają do komendy poza środowiskiem bazowym dziecka.', where: 'src/core/schemas/runner-fields.ts:364; src/engine/runners/sandbox-env.ts:169', group: 'config.yaml', usedBy: ['runners'], inAtlasBefore: true },
    { key: '<seat>.capabilities (planner / reviewer kind shell | agent)', values: 'partial { supportsConversationalPlanning, supportsSessionResume, supportsEffort, supportsImages, supportsSelfSummarisation }', default: 'brak (wszystko false)', effect: 'supportsSessionResume, supportsEffort, supportsImages: true są odrzucane na shell/agent. supportsSelfSummarisation włącza kompakcję przy resume. Na implementerze pole nie istnieje (strict).', where: 'src/core/schemas/runner-fields.ts:79; src/core/schemas/runner-fields.ts:509; src/engine/orchestrator/resume-context.ts:40', group: 'config.yaml', usedBy: ['runners', 'subsystems'], inAtlasBefore: true },
    { key: 'validation.endChecks (end_checks)', values: 'boolean', default: 'true (resolveEndChecks)', effect: 'Włącza wybór i uruchomienie checków reviewera przed review. false: żaden check reviewera nie biegnie, checki planu nadal tak.', where: 'src/core/schemas/config.ts:66; src/core/config/runtime/resolve.ts:11', group: 'config.yaml', usedBy: ['review', 'ui', 'startup'], inAtlasBefore: true },
    { key: 'validation.approveChecks (approve_checks)', values: 'ask | auto', default: 'auto (resolveApproveChecks)', effect: 'ask: jedna karta Run all / Skip all przed checkami reviewera; headless bez karty nie uruchamia żadnego. Pominięty check nigdy nie jest pass.', where: 'src/core/schemas/config.ts:68; src/core/config/runtime/resolve.ts:16', group: 'config.yaml', usedBy: ['review', 'ui'], inAtlasBefore: true },
    { key: 'validation.testCommand (test_command)', values: 'string niepusty, argv bez shella', default: 'brak: komenda stacku (5 stacków registry)', effect: 'Komenda checku test planera, uruchamiana jak napisana, bez zawężania do plików. Poza 5 stackami bez tego klucza check test jest not-runnable.', where: 'src/core/schemas/config.ts:75; src/core/readiness/checks/validation.ts:35; src/core/settings/catalog.ts:130', group: 'config.yaml', usedBy: ['build', 'review', 'planning', 'startup'], inAtlasBefore: true },
    { key: 'validation.testPattern (test_pattern)', values: 'wzorzec nazwy pliku z jedną *', default: 'brak: wzorce stacku', effect: 'Zawężanie checku test do plików testowych obok zmienionego pliku. Wzorzec odkryty przez planera jest odrzucany, gdy niebezpieczny.', where: 'src/core/schemas/config.ts:80; src/engine/orchestrator/validation/commands.ts:42', group: 'config.yaml', usedBy: ['build', 'review'], inAtlasBefore: true },
    { key: 'validation.timeoutMs (timeout_ms)', values: 'int >= 1000', default: '3600000 (STAGE_TIMEOUT_MS)', effect: 'Limit na każdą komendę checku: plan check, check reviewera, base re-run, render. Jedyny limit komend uruchamianych przez SPLITBRIEF.', where: 'src/core/schemas/config.ts:81; src/engine/orchestrator/validation/run.ts:33; src/core/pipeline-spec/gates.ts:8', group: 'config.yaml', usedBy: ['build', 'review'], inAtlasBefore: true },
    { key: 'validation.stack', values: 'typescript | javascript | python | go | rust', default: 'brak: detekcja po plikach markerów', effect: 'Przypina stack, przez który check test rozwiązuje komendę i wzorce testów.', where: 'src/core/schemas/config.ts:82; src/core/validation/stacks/types.ts:1; src/engine/orchestrator/validation/run.ts:63', group: 'config.yaml', usedBy: ['build', 'review', 'planning'], inAtlasBefore: true },
    { key: 'validation.render', values: 'komenda z {id} i {out}', default: 'brak', effect: 'Komenda checku render; bez niej render check jest not-runnable, a plan z render checkami dostaje uwagę. PNG z {out} kopiowane do sessions/<id>/renders/<check>/.', where: 'src/core/schemas/config.ts:83; src/engine/orchestrator/validation/run-checks.ts:293; src/engine/spec/plan-checks.ts:190', group: 'config.yaml', usedBy: ['review', 'planning', 'build'], inAtlasBefore: true },
    { key: 'validation.typecheck / lint / test / typecheckCommand / lintCommand', values: 'z.unknown() (wycofane)', default: 'brak', effect: 'Ładują się z jedną notice każdy i nic nie zmieniają: reviewer wybiera komendy sam.', where: 'src/core/schemas/config.ts:70; src/core/config/load/validation/config.ts:171', group: 'config.yaml', usedBy: ['startup'], inAtlasBefore: true },
    { key: 'workflow.approve', values: 'plan | none (all, spec, default → plan z notice)', default: 'plan (resolveApproveLevel)', effect: 'Czy karta planu czeka na zatwierdzenie przed budową. Headless zatwierdza kartę bez pytania.', where: 'src/core/schemas/config.ts:86; src/core/schemas/enums.ts:202; src/core/config/runtime/resolve.ts:6', group: 'config.yaml', usedBy: ['planning', 'journey', 'ui', 'startup'], inAtlasBefore: true },
    { key: 'workflow.review', values: 'end | task', default: 'end (dopisane przez loader)', effect: 'task: każdy brief ma własne checki i review przed finalnym review. end: tylko finalne review z checkami reviewera.', where: 'src/core/schemas/config.ts:87; src/engine/orchestrator/task/loop.ts:270', group: 'config.yaml', usedBy: ['build', 'review'], inAtlasBefore: true },
    { key: 'workflow.isolation', values: 'worktree | staged-copy | none', default: 'worktree (getIsolationStrategy); init nie zapisuje klucza', effect: 'Gdzie pisze implementer i biegną checki. none to Twój checkout bez Apply. Brak klucza przy stackach, których worktree nie obsłuży, to blocker readiness.', where: 'src/core/schemas/config.ts:91; src/core/config/accessors/values.ts:9; src/core/readiness/checks/isolation.ts:100', group: 'config.yaml', usedBy: ['lifecycle', 'build', 'review', 'startup', 'ui'], inAtlasBefore: true },
    { key: 'workflow.git.createBranch', values: 'boolean', default: 'false (brak klucza)', effect: 'Tworzy gałąź splitbrief/<slug> na starcie runu. Jedyny aktywny klucz bloku git.', where: 'src/core/schemas/config.ts:30; src/engine/orchestrator/run/init.ts:480', group: 'config.yaml', usedBy: ['lifecycle', 'ui'], inAtlasBefore: true },
    { key: 'workflow.git.commitStrategy (commit_strategy)', values: 'none ładuje się i jest usuwane; checkpoint | per-task to błąd', default: 'brak', effect: 'Pozostałość po automatycznych commitach. none przechodzi bez notice i znika z załadowanego configu; inne wartości kończą ładowanie błędem „was removed”.', where: 'src/core/schemas/config.ts:29; src/core/schemas/config.ts:35', group: 'config.yaml', usedBy: ['lifecycle'], inAtlasBefore: true },
    { key: 'workflow.compactionThreshold', values: 'int >= 10', default: 'brak (kompakcja wyłączona)', effect: 'Przy resume: gdy transkrypt ma więcej wiadomości i planner umie się streszczać (supportsSelfSummarisation), dopisywany jest rekord summary.', where: 'src/core/schemas/config.ts:102; src/engine/orchestrator/resume-context.ts:37', group: 'config.yaml', usedBy: ['lifecycle', 'subsystems'], inAtlasBefore: true },
    { key: 'workflow.compactionFormat', values: 'auto | freeform | structured', default: 'auto (schemat .default)', effect: 'auto: structured dla planera api, freeform dla pozostałych. Jedyny klucz workflow z .default() w schemacie.', where: 'src/core/schemas/config.ts:103; src/core/schemas/compaction.ts:18', group: 'config.yaml', usedBy: ['subsystems', 'ui'], inAtlasBefore: true },
    { key: 'workflow.showSpend (show_spend)', values: 'boolean', default: 'brak', effect: 'Przyjmowany przez schemat, nieczytany przez żaden moduł. Nie ma ustawienia Show spend; /usage pokazuje koszty.', where: 'src/core/schemas/config.ts:104', group: 'config.yaml', usedBy: [], inAtlasBefore: false },
    { key: 'workflow.mode / speckit / briefReview / taskReview / driftChainThreshold / maxRetries', values: 'z.unknown() (wycofane)', default: 'brak', effect: 'Ładują się z jedną notice każdy i nic nie zmieniają. maxRetries zastąpiły BOUNDS.attemptsPerLineage.', where: 'src/core/schemas/config.ts:89; src/core/schemas/config.ts:93; src/core/config/load/validation/config.ts:127', group: 'config.yaml', usedBy: ['planning', 'startup', 'build'], inAtlasBefore: true },
    { key: 'sessions.scope', values: 'project (jedyna wartość)', default: 'brak', effect: 'Przyjmowany, nieczytany: sesje zawsze leżą w <projekt>/.splitbrief/sessions. Wartość global jest odrzucana przez enum.', where: 'src/core/schemas/config.ts:106', group: 'config.yaml', usedBy: [], inAtlasBefore: false },
    { key: 'escalation', values: 'z.unknown() (wycofany blok)', default: 'brak', effect: 'Ładuje się z jedną notice; konsultacja planera zastąpiła tier pośredni.', where: 'src/core/schemas/config.ts:112; src/core/config/load/validation/config.ts:184', group: 'config.yaml', usedBy: ['startup'], inAtlasBefore: true },
    { key: 'codebase.enabled', values: 'boolean', default: 'true (schemat .default)', effect: 'Czy planner dostaje blok <repo-map>.', where: 'src/core/schemas/codebase.ts:4; src/engine/orchestrator/planning/session.ts:187', group: 'config.yaml', usedBy: ['planning', 'subsystems'], inAtlasBefore: true },
    { key: 'codebase.tokenBudget', values: 'int 1..50000', default: '4000', effect: 'Budżet tokenów mapy repo; PageRank wybiera symbole, które się mieszczą.', where: 'src/core/schemas/codebase.ts:5; src/engine/orchestrator/planning/session.ts:191', group: 'config.yaml', usedBy: ['planning', 'subsystems'], inAtlasBefore: true },
    { key: 'codebase.include / codebase.exclude', values: 'include: globy; exclude: regexy (dodawane do domyślnych)', default: 'include: znane rozszerzenia; exclude: .git, .splitbrief, node_modules, .trees, dist, pliki .test', effect: 'Zakres plików repo-map. exclude nie zastępuje domyślnych wykluczeń.', where: 'src/core/schemas/codebase.ts:6; src/engine/orchestrator/planning/session.ts:193', group: 'config.yaml', usedBy: ['planning', 'subsystems'], inAtlasBefore: true },
    { key: 'hooks.<event>[]', values: 'event ∈ pre_planning, pre_task, post_task, pre_validation, post_validation, pre_escalation, on_error, on_halt, on_complete (+ wycofane pre_commit, post_commit)', default: 'brak', effect: 'Listy wpisów hooków. pre_* mogą zablokować akcję (deny albo crash z on_failure block); post_* i on_* są fire-and-forget. Uruchomienie wymaga zaufania (~/.splitbrief/trust/hooks.json albo --allow-hooks).', where: 'src/core/schemas/hooks.ts:7; src/core/schemas/hooks.ts:368; src/engine/hooks/run-pre.ts:11', group: 'config.yaml', usedBy: ['subsystems', 'planning', 'build', 'startup'], inAtlasBefore: true },
    { key: 'hooks.<event>[].kind / name', values: 'kind: literal command; name: string', default: 'kind: command; name: brak (etykieta = command)', effect: 'kind jest jedynym rodzajem (module odrzucone). name służy tylko do etykiet ostrzeżeń.', where: 'src/core/schemas/hooks.ts:313; src/engine/hooks/run-pre.ts:38', group: 'config.yaml', usedBy: ['subsystems'], inAtlasBefore: false },
    { key: 'hooks.<event>[].command / args', values: 'command: plik, nie launcher shella; args: string[] z ${event.<pole>}', default: 'args: []', effect: 'sh, bash, env, pwsh… i flagi -c / --call / /c są odrzucane przy ładowaniu. Podstawienie bez eval, bez shell: true.', where: 'src/core/schemas/hooks.ts:315; src/core/schemas/hooks.ts:320', group: 'config.yaml', usedBy: ['subsystems'], inAtlasBefore: true },
    { key: 'hooks.<event>[].timeout_ms', values: 'int 1..300000', default: '30000', effect: 'Limit jednego hooka; przekroczenie liczy się jak crash i podlega on_failure.', where: 'src/core/schemas/hooks.ts:317; src/engine/hooks/dispatch.ts:53', group: 'config.yaml', usedBy: ['subsystems'], inAtlasBefore: true },
    { key: 'hooks.<event>[].on_failure', values: 'block | warn | ignore', default: 'warn', effect: 'Co z crashem, timeoutem, kodem != 0 i złą odpowiedzią JSON. decision: deny blokuje pre_* niezależnie od on_failure. ENOENT zawsze warn.', where: 'src/core/schemas/hooks.ts:318; src/engine/hooks/dispatch.ts:175', group: 'config.yaml', usedBy: ['subsystems'], inAtlasBefore: true },
    { key: 'hooks.pre_commit / hooks.post_commit', values: 'tylko pusta lista', default: 'brak', effect: 'Pusta lista ładuje się i jest usuwana; niepusta kończy ładowanie błędem „were removed”.', where: 'src/core/schemas/hooks.ts:366; src/core/schemas/hooks.ts:372', group: 'config.yaml', usedBy: ['subsystems'], inAtlasBefore: true },
    { key: 'palette.customActions[]', values: '{ id, label, description?, command: /… }', default: 'brak', effect: 'Dodatkowe akcje palety; command musi zaczynać się od /. Blok palette nie jest strict.', where: 'src/core/schemas/config.ts:17; src/features/palette/sources.ts:184', group: 'config.yaml', usedBy: ['ui'], inAtlasBefore: true },
    { key: 'approval.feedRejectionsToPlanner', values: 'boolean', default: 'true (schemat .default)', effect: 'false: odrzucony zapis do chronionej ścieżki nie trafia do następnego promptu planera.', where: 'src/core/schemas/config.ts:51; src/engine/orchestrator/planning/call-loop.ts:14', group: 'config.yaml', usedBy: ['planning', 'build', 'subsystems'], inAtlasBefore: true },
    { key: 'approval.allowedPaths', values: 'string[] globów', default: 'brak', effect: 'Rozszerza klasę write_in_scope; nigdy nie zawęża i nie wyłącza pytania o ścieżkę chronioną.', where: 'src/core/schemas/config.ts:52; src/engine/orchestrator/approval/action-classifier.ts:151', group: 'config.yaml', usedBy: ['build'], inAtlasBefore: true },
    { key: 'approval.enabled / approval.tiers', values: 'z.unknown() (wycofane)', default: 'brak', effect: 'Jedna notice każdy; zapis do chronionej ścieżki zawsze pyta, inny nigdy.', where: 'src/core/schemas/config.ts:48; src/core/config/load/validation/config.ts:152', group: 'config.yaml', usedBy: ['planning', 'startup'], inAtlasBefore: true },
    { key: 'otel / snapshots / trust / plannerEstimateReview / autoSplitOverflow / compiler', values: 'usunięte klucze główne', default: 'brak', effect: 'Choć korzeń nie jest strict, te nazwy są błędem ładowania z nazwą ścieżki (compiler z własnym tekstem).', where: 'src/core/config/load/validation/config.ts:95; src/core/config/load/validation/config.ts:110', group: 'config.yaml', usedBy: ['startup'], inAtlasBefore: true },

    { key: '-V, --version / -h, --help', values: 'flagi globalne', default: 'brak', effect: 'Wersja z package.json; help komendy po jej nazwie. help [command] jest komendą commandera.', where: 'src/cli.ts:28', group: 'cli-flag', usedBy: ['startup'], inAtlasBefore: true },
    { key: '--model <model> / --provider <provider>', values: 'aliasy --implementer-model / --implementer', default: 'brak', effect: 'Nadpisują model i narzędzie seatu BUILD (profil domyślny) na jedno uruchomienie.', where: 'src/cli/options.ts:215; src/core/config/runtime/overrides/from-options.ts:17', group: 'cli-flag', usedBy: ['startup', 'runners'], inAtlasBefore: true },
    { key: '--planner <tool> / --implementer <provider> / --reviewer <tool>', values: 'id z PLANNER_TOOL_IDS / IMPLEMENTER_TOOL_IDS (CLI, api z katalogu, shell, agent)', default: 'z pliku', effect: 'Id CLI zawsze wybiera CLI; nazwa api spoza katalogu jest możliwa tylko w YAML. Zmiana celu kasuje effort/variant, zachowuje timeout i fallback.', where: 'src/cli/options.ts:218; src/cli/options.ts:240; src/cli/options.ts:267; src/core/config/runtime/build-runner.ts:250', group: 'cli-flag', usedBy: ['startup', 'runners'], inAtlasBefore: true },
    { key: '--planner-model / --implementer-model / --reviewer-model <model>', values: 'string', default: 'z pliku', effect: 'Model seatu na to uruchomienie; na cli przechodzi politykę modelu narzędzia.', where: 'src/cli/options.ts:221; src/cli/options.ts:244; src/cli/options.ts:271', group: 'cli-flag', usedBy: ['startup', 'runners'], inAtlasBefore: true },
    { key: '--planner-command / --implementer-command / --reviewer-command <cmd>', values: 'ścieżka', default: 'z pliku', effect: 'Bez --<seat> wymusza kind shell. Komenda nadal potrzebuje zaufania (--allow-repo-runners w headless).', where: 'src/cli/options.ts:222; src/core/config/runtime/overrides/runner.ts:146', group: 'cli-flag', usedBy: ['startup', 'runners'], inAtlasBefore: true },
    { key: '--planner-api-base / --implementer-api-base / --reviewer-api-base <url>', values: 'URL', default: 'z pliku albo katalogu', effect: 'Tylko kind api; na innym kind ignorowane z ostrzeżeniem na stderr.', where: 'src/cli/options.ts:223; src/core/config/runtime/overrides/runner.ts:97', group: 'cli-flag', usedBy: ['startup', 'runners'], inAtlasBefore: true },
    { key: '--planner-api-key-env / --implementer-api-key-env / --reviewer-api-key-env <var>', values: 'nazwa zmiennej (goła nazwa → env:<var>)', default: 'brak', effect: 'Zapisuje odwołanie env:VAR w apiKey na to uruchomienie; podlega regułom poświadczeń (provider własny odrzuca). Tylko kind api.', where: 'src/cli/options.ts:224; src/cli/options.ts:187', group: 'cli-flag', usedBy: ['startup', 'runners'], inAtlasBefore: true },
    { key: '--planner-args / --implementer-args / --reviewer-args <arg>', values: 'powtarzalne', default: 'brak', effect: 'Dokłada argv; każdy token przechodzi preflight autorytetu.', where: 'src/cli/options.ts:229; src/cli/options.ts:30', group: 'cli-flag', usedBy: ['startup', 'runners'], inAtlasBefore: true },
    { key: '--planner-output-format / --implementer-output-format / --reviewer-output-format <format>', values: 'stream-json | jsonl | text | opencode', default: 'parser adaptera', effect: 'Parser stdout; na narzędziach z protokołem terminalnym konfiguracja efektywna nie przejdzie walidacji.', where: 'src/cli/options.ts:230; src/cli/options.ts:50', group: 'cli-flag', usedBy: ['startup', 'runners'], inAtlasBefore: true },
    { key: '--planner-context-length / --implementer-context-length / --reviewer-context-length <tokens>', values: 'int > 0', default: 'z pliku', effect: 'contextLength seatu na to uruchomienie. Dla implementera CLIOverrides.contextLength trafia do profilu domyślnego.', where: 'src/cli/options.ts:235; src/cli/options.ts:42; src/core/config/runtime/overrides/apply.ts:31', group: 'cli-flag', usedBy: ['startup', 'runners'], inAtlasBefore: true },
    { key: '--planner-effort / --reviewer-effort <level>', values: 'none | minimal | low | medium | high | xhigh | max', default: 'brak', effect: 'Nakłada effort na PLAN / REVIEW. --reviewer-effort przy REVIEW = PLAN kończy się błędem. Nie ma --implementer-effort.', where: 'src/cli/options.ts:298; src/core/config/runtime/overrides/apply.ts:46; src/core/config/runtime/overrides/runner.ts:215', group: 'cli-flag', usedBy: ['startup', 'runners'], inAtlasBefore: true },
    { key: '--project <dir>', values: 'katalog', default: 'cwd', effect: 'Katalog projektu; katalog wewnątrz repo git jest zamieniany na korzeń repo z ostrzeżeniem. Obecny na każdej komendzie.', where: 'src/cli/options.ts:294; src/cli/setup.ts:29', group: 'cli-flag', usedBy: ['startup'], inAtlasBefore: true },
    { key: '--no-fullscreen / --no-mouse / --hover', values: 'boolean', default: 'fullscreen i mysz włączone (tylko na TTY i bez CI); hover false', effect: 'Mysz wymaga fullscreen; hover wymaga myszy. Paste bracketed idzie za fullscreen.', where: 'src/cli/options.ts:295; src/cli/setup.ts:157; src/cli/render/input-config.ts:12', group: 'cli-flag', usedBy: ['startup', 'ui'], inAtlasBefore: true },
    { key: '--allow-hooks', values: 'boolean', default: 'false', effect: 'Omija prompt zaufania hooków (CI). Nie autoryzuje celu niekwalifikowalnego (symlink w hooku). Dostępne na start/resume/continue/spec.', where: 'src/cli/options.ts:306; src/cli/hook-trust-prompt.ts:51; src/cli/commands/spec.ts:109', group: 'cli-flag', usedBy: ['startup', 'subsystems'], inAtlasBefore: true },
    { key: '--allow-repo-runners', values: 'boolean', default: 'false', effect: 'Nadaje runowi każdą komendę shell/agent z configu bez receiptu; nie jest zapisywane. Na start/resume/continue/spec/review.', where: 'src/cli/options.ts:307; src/cli/options.ts:27; src/cli/commands/review.ts:125', group: 'cli-flag', usedBy: ['startup', 'runners'], inAtlasBefore: true },
    { key: '--allow-unverified-auth', values: 'boolean', default: 'false', effect: 'Headless (--json/--plain, review) startuje mimo niezweryfikowanego logowania CLI. Interaktywnie bez skutku.', where: 'src/cli/options.ts:308; src/cli/headless.ts:300; src/cli/commands/review.ts:126', group: 'cli-flag', usedBy: ['startup'], inAtlasBefore: true },
    { key: '--json / --plain', values: 'boolean, wzajemnie wykluczające się (exit 2)', default: 'false (TUI)', effect: 'Headless: NDJSON albo linie tekstu na stdout, bez TUI. Wymaga argumentu feature na start. Karta planu zatwierdzana bez pytania; approve_checks: ask nie uruchamia checków.', where: 'src/cli/options.ts:313; src/cli/options.ts:351; src/cli/commands/start/register.ts:33', group: 'cli-flag', usedBy: ['startup', 'journey', 'lifecycle', 'subsystems'], inAtlasBefore: true },
    { key: '--skills <ids>', values: 'lista id po przecinku', default: 'brak', effect: 'Dołącza skille do każdego seatu; nieznany id → exit 2. Na resume/continue tylko na to wznowienie.', where: 'src/cli/options.ts:319; src/cli/options.ts:60; src/cli/commands/start/streaming.ts:25', group: 'cli-flag', usedBy: ['startup', 'subsystems'], inAtlasBefore: true },
    { key: '--action <action> (resume, continue)', values: 'skip | retry | restore | switch-seat:<tool>[:<model>][@<effort>] | end-run | apply | discard', default: 'brak: TUI z panelem recovery', effect: 'Odpowiada na zawieszone recovery albo rozstrzyga run ready-to-apply. @<word> na opencode/kilo-code jest variantem. start nie ma tej flagi.', where: 'src/cli/options.ts:324; src/cli/options.ts:126', group: 'cli-flag', usedBy: ['recovery', 'lifecycle', 'startup'], inAtlasBefore: true },
    { key: '--on-seat-down <policy>', values: 'halt | switch', default: 'brak = jak switch', effect: 'Headless: halt zatrzymuje na Seat down; switch stosuje zadeklarowany fallback; switch bez fallbacku to exit 2 przed startem.', where: 'src/cli/options.ts:332; src/cli/headless.ts:365; src/core/types/config-options.ts:4', group: 'cli-flag', usedBy: ['recovery', 'startup', 'runners'], inAtlasBefore: true },
    { key: 'init --reconfigure / --yes', values: 'boolean', default: 'false / false', effect: '--reconfigure zastępuje istniejący config; --yes zapisuje wykrytą gotową załogę bez pickera (jedyna droga headless dla init).', where: 'src/cli/commands/init.ts:28; src/core/config/load/io.ts:291', group: 'cli-flag', usedBy: ['startup'], inAtlasBefore: true },
    { key: 'doctor --json / --probe-seat <plan|build|review>', values: 'boolean / enum', default: 'brak', effect: '--json wypisuje raport readiness jako JSON. --probe-seat robi jedno płatne wywołanie przez adapter CLI seatu (limit 60 s) i dopisuje rekord do .splitbrief/probes/<tool>-<date>.jsonl.', where: 'src/cli/commands/doctor.ts:411; src/cli/commands/doctor.ts:80; src/cli/commands/doctor.ts:109', group: 'cli-flag', usedBy: ['startup'], inAtlasBefore: true },
    { key: 'review --reviewer <spec> / --base <ref>', values: '<tool>[:<model>][@<effort>] / git ref bez wiodącego -', default: 'skonfigurowany reviewer albo planner / drzewo robocze', effect: 'Jedno wywołanie reviewera bez sesji. --base porównuje git diff <ref> plus pliki nieśledzone.', where: 'src/cli/commands/review.ts:114; src/cli/options.ts:88; src/cli/options.ts:176', group: 'cli-flag', usedBy: ['startup', 'review'], inAtlasBefore: true },
    { key: 'spec <feature> --project / --allow-hooks / --allow-repo-runners', values: 'opcje komendy spec', default: 'cwd / false / false', effect: 'Sama sesja planowania bez budowy; te same bramki zaufania jak start.', where: 'src/cli/commands/spec.ts:106', group: 'cli-flag', usedBy: ['planning'], inAtlasBefore: true },
    { key: 'status --project', values: 'katalog', default: 'cwd', effect: 'Jedyna opcja komendy status; drukuje stan runu z state.json i ewidencji wywołań.', where: 'src/cli/commands/status.ts:69', group: 'cli-flag', usedBy: ['lifecycle'], inAtlasBefore: false },
    { key: '--mode / --approve / --yolo (usunięte)', values: 'odrzucane', default: 'brak', effect: 'exit 1 przed jakąkolwiek pracą z komunikatem „was removed: …”. Sprawdzane na surowym argv, zanim commander parsuje.', where: 'src/cli/unknown-command.ts:26; src/cli/unknown-command.ts:90', group: 'cli-flag', usedBy: ['planning', 'startup'], inAtlasBefore: true },

    { key: 'SPLITBRIEF_DEBUG', values: '1 | 0 | false | puste', default: 'brak: dev (.ts) włączony, build wyłączony', effect: 'Włącza logger do .splitbrief/logs/debug.log. 0 i false wyłączają także w dev.', where: 'src/core/logger.ts:5; src/core/logger.ts:9', group: 'env', usedBy: ['subsystems'], inAtlasBefore: true },
    { key: 'SPLITBRIEF_DEBUG_KEYS', values: 'niepuste, nie 0/false', default: 'brak', effect: 'Loguje surowe i sparsowane klawisze do .splitbrief/debug/keys-* (albo temp bez projektu).', where: 'src/core/key-debug.ts:10; src/core/key-debug.ts:25', group: 'env', usedBy: ['subsystems', 'ui'], inAtlasBefore: true },
    { key: 'SPLITBRIEF_CONTEXT_LENGTH', values: 'liczba całkowita', default: 'brak', effect: 'Pierwsze źródło contextLength implementera (profil domyślny), przed config, wykryciem i katalogiem.', where: 'src/engine/providers/capabilities.ts:47', group: 'env', usedBy: ['runners', 'build'], inAtlasBefore: true },
    { key: 'SPLITBRIEF_REDUCE_MOTION / REDUCE_MOTION', values: '1', default: 'brak', effect: 'Spinner co 1000 ms zamiast 120 ms; status ticks spowolnione.', where: 'src/lib/terminal/reduce-motion.ts:1; src/hooks/use-spinner-frame.ts:5', group: 'env', usedBy: ['ui'], inAtlasBefore: false },
    { key: 'SPLITBRIEF_TEST_CLIPBOARD_CALLS', values: 'zdefiniowane', default: 'brak', effect: 'Dźwignia testowa w kodzie produkcyjnym: timeout natywnego schowka 15 s zamiast 2 s.', where: 'src/lib/clipboard/native.ts:34', group: 'env', usedBy: ['ui'], inAtlasBefore: false },
    { key: 'FORCE_HYPERLINK (+ TERM_PROGRAM, VTE_VERSION, KITTY_WINDOW_ID, WT_SESSION, TERM)', values: '0/false wymusza off; inna niepusta wartość on', default: 'wykrywanie terminala; Apple_Terminal wyłączony', effect: 'Czy linki do plików są emitowane jako OSC 8.', where: 'src/lib/terminal/hyperlinks.ts:6', group: 'env', usedBy: ['ui'], inAtlasBefore: true },
    { key: 'CI', values: 'niepuste', default: 'brak', effect: 'isInteractiveTty() daje false: brak fullscreen, myszy i pickera; headless potrzebuje --json/--plain albo init --yes.', where: 'src/cli/setup.ts:52', group: 'env', usedBy: ['startup'], inAtlasBefore: true },
    { key: 'XDG_STATE_HOME', values: 'ścieżka bezwzględna', default: '~/.local/state', effect: 'Korzeń worktree izolacji (…/splitbrief/trees) i baz runu (…/splitbrief/bases). Wartość względna jest ignorowana.', where: 'src/core/paths.ts:142; src/core/paths.ts:148', group: 'env', usedBy: ['lifecycle', 'journey'], inAtlasBefore: true },
    { key: 'HOME', values: 'katalog domowy', default: 'os.homedir()', effect: 'Korzeń ~/.splitbrief (trust, history, cache), globalnych skilli i plików wyboru modelu hosta. Dla seatów session na macOS dziecko dostaje prawdziwe HOME i USER.', where: 'src/core/trust/receipt-store.ts:24; src/engine/runners/host-model-selection.ts:13; src/engine/runners/sandbox-env.ts:202', group: 'env', usedBy: ['startup', 'runners'], inAtlasBefore: true },
    { key: 'XDG_CONFIG_HOME', values: 'ścieżka', default: '~/.config', effect: 'Gdzie SPLITBRIEF czyta opencode/opencode.json(c) i kilo/kilo.json(c) dla model: auto oraz cursor/auth.json do bridgingu.', where: 'src/engine/runners/host-model-selection.ts:17; src/engine/runners/host-model-selection.ts:128', group: 'env', usedBy: ['runners'], inAtlasBefore: true },
    { key: 'COPILOT_HOME / COPILOT_CACHE_HOME / XDG_CACHE_HOME / LOCALAPPDATA', values: 'ścieżki', default: 'brak / cache platformy', effect: 'COPILOT_HOME jest przekazywane dziecku copilot; COPILOT_CACHE_HOME albo cache platformy wskazuje launcherowi Copilota pakiet, by przekierowane HOME nie zdegradowało wersji.', where: 'src/engine/runners/sandbox-env.ts:203; src/engine/runners/sandbox-env.ts:212', group: 'env', usedBy: ['runners'], inAtlasBefore: true },
    { key: 'ANTHROPIC_API_KEY / OPENAI_API_KEY / COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN / CURSOR_API_KEY', values: 'poświadczenia', default: 'brak', effect: 'Jedyne zmienne, które kanał api-key (claude-code, codex, cursor) albo session (copilot) narzędzia CLI przenosi do dziecka. Nie dowodzą metody rozliczeń.', where: 'src/core/runners/cli-tool-catalog.ts:391; src/core/runners/cli-tool-catalog.ts:434; src/core/runners/cli-tool-catalog.ts:508; src/core/runners/cli-tool-catalog.ts:586', group: 'env', usedBy: ['runners', 'startup'], inAtlasBefore: true },
    { key: '*_API_KEY (dowolne) dla kanału provider-dependent', values: 'każda zmienna kończąca się na _API_KEY', default: 'brak', effect: 'opencode i kilo-code dostają każdą taką zmienną z Twojego shella, bo ich poświadczenie należy do providera, nie do narzędzia.', where: 'src/engine/runners/sandbox-env.ts:101; src/engine/runners/sandbox-env.ts:114', group: 'env', usedBy: ['runners'], inAtlasBefore: true },
    { key: 'OLLAMA_LOCAL_API_KEY', values: 'token', default: 'brak', effect: 'Jedyne odwołanie env: dopuszczone dla providera ollama (apiKey: env:OLLAMA_LOCAL_API_KEY). OLLAMA_API_KEY nie jest akceptowane lokalnie.', where: 'src/core/schemas/runner-fields.ts:205; src/core/providers/ollama-credential.ts:1', group: 'env', usedBy: ['runners'], inAtlasBefore: true },
    { key: 'env:<VAR> z apiKey', values: 'dowolna nazwa zmiennej', default: 'brak', effect: 'Rozwiązywane przy ładowaniu (brak wartości = błąd) i przy wywołaniu (api-key.ts). Dla lm-studio / llama-cpp dowolna; dla providera własnego odrzucone.', where: 'src/core/config/credentials.ts:12; src/core/config/load/validation/credentials.ts:23; src/engine/providers/client/api-key.ts:15', group: 'env', usedBy: ['runners', 'startup'], inAtlasBefore: true },
    { key: 'VISUAL / EDITOR / PAGER', values: 'komenda', default: 'vi (edycja plan.json); less dla Show diff', effect: 'VISUAL wygrywa; EDITOR nieterminalowy przed wykrytym GUI; terminalowy po nim. Show diff: VISUAL → EDITOR → PAGER → less z -+E -+F -+M -+X.', where: 'src/features/workflow/editor-command.ts:159; src/features/workflow/editor-command.ts:186', group: 'env', usedBy: ['ui'], inAtlasBefore: true },
    { key: 'COLORFGBG', values: 'np. 15;0', default: 'brak', effect: 'Wybór wariantu motywu (dark/light), gdy terminal nie odpowiada na zapytanie o tło; bez niego dark.', where: 'src/core/theme/resolve.ts:104; src/core/theme/resolve.ts:114', group: 'env', usedBy: ['ui'], inAtlasBefore: false },
    { key: 'TERM / LANG / LC_ALL / LC_CTYPE / WT_SESSION (poziom glifów)', values: 'TERM linux lub dumb → ascii; locale bez utf-8 → ascii', default: 'unicode na TTY z locale UTF-8 albo pustą', effect: 'Wybiera tabelę glifów (ramki, spinner braille vs liniowy). Nie-TTY zawsze ascii.', where: 'src/lib/glyphs.ts:137', group: 'env', usedBy: ['ui'], inAtlasBefore: false },
    { key: 'TERM_PROGRAM (protokół klawiatury kitty)', values: 'iTerm.app | zed → enabled', default: 'auto', effect: 'Wymusza protokół klawiatury kitty w terminalach, które go nie ogłaszają.', where: 'src/lib/terminal/kitty-keyboard.ts:7', group: 'env', usedBy: ['ui'], inAtlasBefore: false },
    { key: 'TMUX / STY / SSH_CONNECTION / LC_TERMINAL (schowek)', values: 'obecność', default: 'brak', effect: 'Ścieżka kopiowania: przez SSH pomija narzędzie natywne; w tmux próbuje bufora tmux; potem OSC 52 opakowane dla multipleksera.', where: 'src/lib/clipboard/clipboard.ts:10; src/lib/clipboard/native.ts:84', group: 'env', usedBy: ['ui'], inAtlasBefore: false },
    { key: 'PATH / PATHEXT', values: 'lista katalogów', default: 'z shella', effect: 'Rozwiązywanie plików wykonywalnych CLI, hooków i checków. Komendy SPLITBRIEF dostają PATH tylko z wpisami bezwzględnymi, by nie rozwiązywać względem workspace.', where: 'src/lib/process/command-path.ts:6; src/lib/process/spawn/child-env.ts:92', group: 'env', usedBy: ['runners', 'startup'], inAtlasBefore: false },
    { key: 'GIT_* (lista przepuszczana do git)', values: 'GIT_SSH*, GIT_ASKPASS, GIT_PROXY_*, GIT_SSL_*, GIT_HTTP_*, GIT_LFS_SKIP_*, GIT_ALLOW_PROTOCOL, GIT_TERMINAL_PROMPT', default: 'brak', effect: 'simple-git usuwa każde GIT_* oraz EDITOR, VISUAL, PAGER, PREFIX; SPLITBRIEF przywraca tylko te z listy. GIT_CONFIG_GLOBAL i GIT_TRACE nie docierają.', where: 'src/lib/git/client.ts:23', group: 'env', usedBy: ['lifecycle'], inAtlasBefore: false },
    { key: 'NODE_ENV', values: 'production (ustawiane, nie czytane)', default: 'production', effect: 'node-env.ts ustawia production przed importem Reacta, by dev build nie zapełniał bufora performance.measure.', where: 'src/node-env.ts:4', group: 'env', usedBy: ['structure'], inAtlasBefore: true },

    { key: '.splitbrief/config.yaml', values: 'YAML, version 3', default: 'brak pliku = konfiguracja domyślna', effect: 'Jedyne źródło konfiguracji projektu. Zapis atomowy z trybem 0600 i kontrolą rewizji (sha256 + inode); konflikt rewizji odrzuca zapis. Pierwszy zapis dodaje .splitbrief/ do .gitignore.', where: 'src/core/config/load/document.ts:22; src/core/config/load/io.ts:232; src/core/config/load/document.ts:46', group: 'settings-file', usedBy: ['startup', 'ui'], inAtlasBefore: true },
    { key: '.splitbrief/ui-prefs.json', values: '{ sidebarVisible: boolean }', default: 'sidebarVisible: true', effect: 'Pamięta widoczność sidebara workflow między startami. Nieczytelny plik daje ostrzeżenie i domyślny układ.', where: 'src/core/ui-prefs.ts:7; src/core/ui-prefs.ts:23', group: 'settings-file', usedBy: ['ui'], inAtlasBefore: true },
    { key: '.splitbrief/sessions/<id>/draft.json', values: 'DraftDocument { version: 1, parts }', default: 'brak pliku = pusty draft', effect: 'Niewysłany tekst kompozytora runu; pusty draft nie tworzy pliku; błąd zapisu zatrzymuje wyjście i nazywa plik.', where: 'src/core/sessions/draft.ts:18; src/core/sessions/draft.ts:46', group: 'settings-file', usedBy: ['ui', 'lifecycle'], inAtlasBefore: true },
    { key: '~/.splitbrief/history', values: 'envelope { version: 1, entries } albo linie', default: 'brak', effect: 'Historia promptów kompozytora między projektami, z redakcją sekretów, zapis z debounce 300 ms, do 50 wpisów.', where: 'src/stores/ui/persistence.ts:25; src/stores/ui/input-history.ts:12', group: 'settings-file', usedBy: ['ui'], inAtlasBefore: false },
    { key: '~/.splitbrief/trust/hooks.json', values: '{ version: 1, receipts: [{ projectIdentity, configDigest, trustedAt }] }', default: 'brak = hooki niezaufane', effect: 'Receipty zaufania hooków per realpath projektu i skrót bloku hooks. Plik czytany z O_NOFOLLOW, musi mieć tryb bez bitów 0o077, do 256 KiB i 512 receiptów; inaczej traktowany jak brak.', where: 'src/core/hooks/trust.ts:11; src/core/trust/receipt-store.ts:23; src/core/trust/receipt-store.ts:9', group: 'settings-file', usedBy: ['startup', 'subsystems'], inAtlasBefore: true },
    { key: '~/.splitbrief/trust/custom-runners.json', values: 'receipty komend shell/agent', default: 'brak = komendy niezaufane', effect: 'Zgoda właściciela na konkretny tupel wykonawczy runnera własnego w konkretnym checkout. Repozytorium nie może go dostarczyć.', where: 'src/engine/runners/custom-trust.ts:21; src/engine/runners/custom-trust.ts:220', group: 'settings-file', usedBy: ['startup', 'runners'], inAtlasBefore: false },
    { key: '~/.splitbrief/cache/models-dev-catalog-<sha256>.json', values: 'migawka katalogu models.dev', default: 'brak', effect: 'Cache cen i okien modeli dla providerów api; ważny 1 h (MODELS_DEV_CATALOG_CACHE_TTL_MS), pobranie z limitem 10 s.', where: 'src/engine/providers/models-dev-cache/store.ts:26; src/engine/providers/models-dev-cache/store.ts:88; src/engine/providers/models-dev-cache.ts:27', group: 'settings-file', usedBy: ['runners', 'subsystems'], inAtlasBefore: false },
    { key: '.splitbrief/detection-cache.json', values: 'wersja 6, do 100 wpisów, do 500 modeli na wpis', default: 'brak', effect: 'Cache wykrycia narzędzi CLI i providerów (modele, auth, fingerprint binarki), ważny 5 min. Wpis z wartością podobną do sekretu nie jest zapisywany.', where: 'src/engine/detection/cache.ts:27; src/engine/detection/cache.ts:28; src/engine/detection/cache.ts:85', group: 'settings-file', usedBy: ['startup', 'runners'], inAtlasBefore: false },
    { key: '.splitbrief/repomap.sqlite', values: 'baza SQLite', default: 'tworzona przy pierwszym repo-map', effect: 'Cache parsowania tree-sitter i grafu importów dla repo-map planera. Błąd daje pustą mapę i ostrzeżenie.', where: 'src/engine/codebase/cache-path.ts:4; src/engine/codebase/cache-path.ts:11', group: 'settings-file', usedBy: ['subsystems', 'planning'], inAtlasBefore: true },
    { key: '.splitbrief/logs/debug.log / .splitbrief/debug/keys-*', values: 'logi', default: 'wyłączone w buildzie', effect: 'Logger (SPLITBRIEF_DEBUG) i log klawiszy (SPLITBRIEF_DEBUG_KEYS).', where: 'src/core/logger.ts:23; src/core/key-debug.ts:29', group: 'settings-file', usedBy: ['subsystems'], inAtlasBefore: true },
    { key: '.splitbrief/sessions/<id>/lockfile.json', values: '{ pid, startTimeMs, lastAliveMs, sessionId, feature, exitedAt?, exitCode? }', default: 'brak = run nie żyje', effect: 'Heartbeat właściciela runu; ping co 2 s, stary po 8 s (HEARTBEAT_STALENESS_MS). Decyduje, czy run jest running czy stopped.', where: 'src/core/sessions/lockfile-status.ts:10; src/engine/orchestrator/run/heartbeat.ts:5', group: 'settings-file', usedBy: ['lifecycle'], inAtlasBefore: true },
    { key: '~/.local/state/splitbrief/trees/<hash>/<slug> i …/bases', values: 'worktree izolacji i baza runu', default: 'XDG_STATE_HOME albo ~/.local/state', effect: 'Workspace runu leży poza projektem i poza .git, by CLI piszące pliki nie odmawiały ścieżek.', where: 'src/core/paths.ts:148; src/core/paths.ts:151', group: 'settings-file', usedBy: ['lifecycle'], inAtlasBefore: true },
    { key: 'Pliki wyboru modelu hosta (model: auto)', values: '~/.claude/settings.json (model); ~/.codex/config.toml (model na szczycie); $XDG_CONFIG_HOME/opencode/opencode.json(c) i $XDG_STATE_HOME/opencode/model.json; to samo dla kilo; ~/.gemini/antigravity-cli/settings.json', default: 'brak pliku = narzędzie wybiera samo, readiness ostrzega', effect: 'Model, który seat na auto dostaje jawnie jako --model. YAML nie jest przepisywany.', where: 'src/engine/runners/host-model-selection.ts:184; src/engine/runners/host-model-selection.ts:151; src/engine/runners/host-model-selection.ts:122', group: 'settings-file', usedBy: ['runners'], inAtlasBefore: true },
    { key: 'Katalogi skilli', values: 'projekt: .splitbrief/skills, .claude/skills, .agents/skills, .github/skills, .commandcode/skills, .kilo/skills, .kilocode/skills, .cursor/skills; globalnie: ~/.splitbrief/skills, ~/.claude/skills, ~/.agents/skills, ~/.codex/skills, ~/.config/opencode/skills, ~/.commandcode/skills, ~/.kilo/skills, ~/.config/kilo/skills, ~/.cursor/skills', default: 'skan wszystkich', effect: 'Źródła skilli dla /skills i --skills; AGENTS.md projektu liczy się jako wpis.', where: 'src/core/skills/scan-paths.ts:4; src/core/skills/scan-paths.ts:18; src/engine/skill-discovery.ts:222', group: 'settings-file', usedBy: ['subsystems'], inAtlasBefore: true },
    { key: '<project>/.splitbrief/sandbox/', values: 'prywatne HOME, XDG_*, TMPDIR i kopie/linki stanu logowania CLI', default: 'tworzony per run', effect: 'Dziecko CLI na kanale z bridgingiem stanu widzi tylko własne logowanie (kopia dla claude-code/copilot/command-code, link dla codex/cursor/opencode/kilo). Usuwane po runie.', where: 'src/core/paths.ts:11; src/engine/runners/sandbox-env.ts:319', group: 'settings-file', usedBy: ['runners'], inAtlasBefore: false },

    { key: 'BOUNDS.consultsPerLineage / attemptsPerLineage / plannerCallsPerRun', values: '2 / 8 / 10', default: 'stałe', effect: 'Ile konsultacji i prób ma linia briefu, ile wywołań planera ma run. Przekroczenie to halty consult-bound-spent, retry-exhausted, planner-calls-spent.', where: 'src/core/pipeline-spec/bounds.ts:2; src/core/state/machine.ts:181', group: 'constant', usedBy: ['build', 'recovery', 'planning'], inAtlasBefore: true },
    { key: 'BOUNDS.extraConsultsPerLineage / extraAttemptsPerLineage / extraPlannerCallsPerRun / extraFixCyclesPerRun', values: '1 / 4 / 5 / 1', default: 'stałe', effect: 'Dodatek, który użytkownik może przyznać w panelu recovery po wyczerpaniu limitu; każdy raz na run.', where: 'src/core/pipeline-spec/bounds.ts:5; src/engine/orchestrator/recovery/builders/task.ts:324', group: 'constant', usedBy: ['recovery', 'review'], inAtlasBefore: true },
    { key: 'BOUNDS.consultFailingOutputChars / consultDiffChars / consultAttemptLineChars', values: '4000 / 40000 / 200', default: 'stałe', effect: 'Budżety znaków w pakiecie konsultacji planera: wyjście nieudanego checku, diff, linia próby.', where: 'src/core/pipeline-spec/bounds.ts:9; src/engine/orchestrator/recovery/builders/consult.ts:44', group: 'constant', usedBy: ['build'], inAtlasBefore: false },
    { key: 'BOUNDS.toolUseCountLimit', values: '256', default: 'stała', effect: 'Maksymalna liczba zarejestrowanych wywołań narzędzi w jednym wywołaniu seatu (ewidencja wywołań).', where: 'src/core/pipeline-spec/bounds.ts:12; src/engine/calls/output-limit.ts:18', group: 'constant', usedBy: ['subsystems'], inAtlasBefore: false },
    { key: 'BOUNDS.rateLimitResetWaitMs / transientRetries', values: '600000 (10 min) / 3', default: 'stałe', effect: 'Reset limitu krótszy niż 10 min: run czeka; dłuższy: Seat down i fallback. Błąd przejściowy jest powtarzany do 3 razy z backoffem.', where: 'src/core/pipeline-spec/bounds.ts:13; src/engine/orchestrator/escalation/seat-wait.ts:59; src/engine/runners/transient.ts:74', group: 'constant', usedBy: ['recovery', 'runners'], inAtlasBefore: true },
    { key: 'TIMEOUTS.implementerMs / reviewerMs', values: '1200000 / 600000', default: 'stałe', effect: 'Domyślny całkowity budżet wywołania api dla BUILD (20 min) i PLAN/REVIEW (10 min), gdy <seat>.timeout nie jest ustawione.', where: 'src/core/pipeline-spec/timeouts.ts:2; src/engine/providers/api-deadlines.ts:46', group: 'constant', usedBy: ['runners', 'build', 'ui'], inAtlasBefore: true },
    { key: 'TIMEOUTS.consecutiveTimeoutsHalt', values: '2', default: 'stała', effect: 'Dwa timeouty albo cięcia ciszy z rzędu na jednym briefie halt runner-timeout-repeated.', where: 'src/core/pipeline-spec/timeouts.ts:4; src/engine/orchestrator/escalation/local-retries.ts:285', group: 'constant', usedBy: ['build', 'recovery'], inAtlasBefore: true },
    { key: 'TIMEOUTS.sigtermGraceMs / SIGKILL_DELAY_MS', values: '2000', default: 'stała', effect: 'Czas między SIGTERM i SIGKILL przy zatrzymywaniu grupy procesów seatu; rejestr czeka jeszcze 1 s na zniknięcie i 1 s na reap.', where: 'src/core/pipeline-spec/timeouts.ts:5; src/lib/process/registry.ts:6', group: 'constant', usedBy: ['runners', 'lifecycle'], inAtlasBefore: false },
    { key: 'DEFAULT_LOCAL_RETRIES', values: '1', default: 'stała', effect: 'Jedna lokalna powtórka implementera przed konsultacją planera (drabina: recipe-fix → local → consult → takeover).', where: 'src/core/pipeline-spec/retries.ts:1; src/engine/orchestrator/escalation/local-retries.ts:143', group: 'constant', usedBy: ['build'], inAtlasBefore: true },
    { key: 'REVIEW_CYCLE_CAP', values: '2', default: 'stała', effect: 'Ile cykli review → fix → review ma run, zanim halt review-failed.', where: 'src/core/pipeline-spec/review.ts:3', group: 'constant', usedBy: ['review'], inAtlasBefore: true },
    { key: 'VERDICT_RULES.unparseableReask / unparseableVerdict', values: '1 / fail', default: 'stałe', effect: 'Odpowiedź reviewera bez jednego werdyktu jest ponawiana raz; druga nieparsowalna liczy się jako fail.', where: 'src/core/pipeline-spec/review.ts:5', group: 'constant', usedBy: ['review'], inAtlasBefore: false },
    { key: 'STAGE_TIMEOUT_MS', values: '3600000', default: 'stała', effect: 'Domyślny limit komendy checku, gdy validation.timeoutMs nie jest ustawione.', where: 'src/core/pipeline-spec/gates.ts:8; src/engine/orchestrator/validation/run-checks.ts:141', group: 'constant', usedBy: ['build', 'review'], inAtlasBefore: true },
    { key: 'CAPTURE_LIMITS.outputChars / testTailLines', values: '4096 / 40', default: 'stałe', effect: 'Ile wyjścia checku trafia do ewidencji i promptu retry: 4096 znaków i 40 ostatnich linii testu.', where: 'src/core/pipeline-spec/gates.ts:3', group: 'constant', usedBy: ['build'], inAtlasBefore: false },
    { key: 'HALT_TAIL_LINES', values: '60', default: 'stała', effect: 'Ile ostatnich linii stdout/stderr nieudanego wywołania jest przeszukiwanych pod sygnatury haltów (auth, usage, missing-model, spawn, input-too-large).', where: 'src/core/pipeline-spec/halts.ts:75; src/core/pipeline-spec/halts.ts:84', group: 'constant', usedBy: ['recovery'], inAtlasBefore: false },
    { key: 'HAND_BACK_MAX_CHARS / HAND_BACK_PANEL_CHARS', values: '2000 / 300', default: 'stałe', effect: 'Ile tekstu końcowego implementera niesie prompt podpowiedzi i ile cytuje panel recovery.', where: 'src/core/pipeline-spec/ladder.ts:32; src/core/pipeline-spec/ladder.ts:35', group: 'constant', usedBy: ['recovery', 'build'], inAtlasBefore: false },
    { key: 'MAX_QUESTION_ROUNDS / pytania na rundę', values: '2 / 3', default: 'stałe', effect: 'Planner zadaje do 3 pytań na rundę w maksymalnie 2 rundach; trzecia runda to halt plan-questions-exhausted.', where: 'src/engine/spec/prompts/plan-session.ts:11; src/engine/orchestrator/planning/plan-session.ts:106', group: 'constant', usedBy: ['planning'], inAtlasBefore: true },
    { key: 'RUNNER_IDLE_WARN_MS', values: '300000', default: 'stała', effect: 'Domyślny idleWarnMs każdego subprocesu i customCommands; dolna granica dla samotnego idleKillMs.', where: 'src/core/schemas/runner-fields.ts:87', group: 'constant', usedBy: ['runners'], inAtlasBefore: true },
    { key: 'DEFAULT_IMPLEMENTER_TEMPERATURE', values: '0.3', default: 'stała', effect: 'Dopisywana do domyślnego implementera Ollama; nie jest wysyłana do serwera.', where: 'src/core/schemas/runner-fields.ts:88; src/core/config/load/defaults.ts:22', group: 'constant', usedBy: ['startup'], inAtlasBefore: true },
    { key: 'DEFAULT_UNKNOWN_CONTEXT_LENGTH', values: '32768', default: 'stała', effect: 'Ostatnie źródło contextLength, gdy env, config, wykrycie i katalog nic nie dały.', where: 'src/core/tokens/context-length.ts:8; src/engine/providers/capabilities.ts:71', group: 'constant', usedBy: ['build', 'runners'], inAtlasBefore: true },
    { key: 'API_FIRST_RESPONSE_TIMEOUT_MS / STREAM_IDLE_TIMEOUT_MS', values: '120000 / 60000', default: 'stałe', effect: 'Seat api: 120 s do pierwszej odpowiedzi i 60 s ciszy strumienia; oba ograniczone sumą TIMEOUTS.', where: 'src/engine/providers/api-deadlines.ts:8; src/engine/constants.ts:1', group: 'constant', usedBy: ['runners'], inAtlasBefore: true },
    { key: 'BASE_OUTPUT_RESERVE_TOKENS / ESTIMATION_MARGIN_RATIO', values: '2048 / 0.15', default: 'stałe', effect: 'Rezerwa wyjścia i margines estymacji w budżecie pakietu api; brak miejsca to odmowa z liczbami, nie skrócenie.', where: 'src/engine/providers/api-budget.ts:31; src/engine/providers/api-budget.ts:29', group: 'constant', usedBy: ['runners'], inAtlasBefore: false },
    { key: 'DETECTION_TIMEOUT_MS / DISCOVERY_SUBPROCESS_TIMEOUT_MS / DISCOVERY_HTTP_TIMEOUT_MS', values: '5000 / 10000 / 5000', default: 'stałe', effect: 'Limity wykrywania narzędzi CLI, ich katalogów modeli i endpointów api podczas startu i pickera.', where: 'src/engine/constants.ts:2', group: 'constant', usedBy: ['startup', 'runners'], inAtlasBefore: false },
    { key: 'RUNNER_AVAILABILITY_PROBE_TIMEOUT_MS / INVOCATION_TIMEOUT_MS / SEAT_PROBE_TIMEOUT_MS', values: '2000 / 30000 / 60000', default: 'stałe', effect: 'Sonda dostępności runnera, harness kontraktu CLI i doctor --probe-seat.', where: 'src/engine/runners/probe-availability.ts:33; src/engine/runners/cli-tools/contract-harness.ts:26; src/cli/commands/doctor.ts:109', group: 'constant', usedBy: ['startup'], inAtlasBefore: false },
    { key: 'HEARTBEAT_STALENESS_MS / LOCKFILE_PING_INTERVAL_MS', values: '8000 / 2000', default: 'stałe', effect: 'Run bez pingu lockfile przez 8 s jest martwy dla innych procesów.', where: 'src/core/sessions/lockfile-status.ts:10; src/engine/orchestrator/run/heartbeat.ts:5', group: 'constant', usedBy: ['lifecycle'], inAtlasBefore: true },
    { key: 'HEARTBEAT_THRESHOLD_MS / PLANNER_KEEPALIVE_INTERVAL_MS', values: '5000 / 2000', default: 'stałe', effect: 'Po 5 s bez zdarzenia planera byline pokazuje tętno; keepalive co 2 s.', where: 'src/engine/orchestrator/planning/heartbeat.ts:4; src/engine/orchestrator/planning/heartbeat.ts:6', group: 'constant', usedBy: ['planning', 'ui'], inAtlasBefore: true },
    { key: 'MAX_QUEUE_SIZE', values: '50', default: 'stała', effect: 'Pojemność kolejki komend runtime na workflow.', where: 'src/engine/orchestrator/queue/types.ts:7', group: 'constant', usedBy: ['build', 'ui'], inAtlasBefore: true },
    { key: 'CONTEXT_CODE_BUDGET_CHARS', values: '40000', default: 'stała', effect: 'Budżet sekcji Current Code w briefie.', where: 'src/engine/orchestrator/task/refresh-code.ts:35', group: 'constant', usedBy: ['build'], inAtlasBefore: true },
    { key: 'MAX_REVIEW_CHECKS / MAX_RENDER_IMAGES_PER_CHECK', values: '6 / 4', default: 'stałe', effect: 'Reviewer wybiera do 6 checków; do review trafia do 4 obrazów na render check.', where: 'src/core/schemas/review.ts:94; src/engine/orchestrator/review-renders.ts:10', group: 'constant', usedBy: ['review'], inAtlasBefore: true },
    { key: 'MAX_FILE_CHARS / MAX_PROJECT_CHARS (wybór checków)', values: '8000 / 40000', default: 'stałe', effect: 'Ile pliku i ile projektu reviewer czyta przy wyborze checków.', where: 'src/engine/orchestrator/review-checks.ts:77', group: 'constant', usedBy: ['review'], inAtlasBefore: true },
    { key: 'CLI_TOOL_CATALOG.codex.maxInputChars', values: '1048576', default: 'tylko codex', effect: 'Pakiet review większy niż 1 MiB na codex to halt review-input-too-large; inne narzędzia bez capu.', where: 'src/core/runners/cli-tool-catalog.ts:414', group: 'constant', usedBy: ['review'], inAtlasBefore: true },
    { key: 'OFFERED_SEAT_SWAP_CANDIDATES', values: '3', default: 'stała', effect: 'Ile kandydatów przełączenia seatu oferuje panel recovery.', where: 'src/features/workflow/recovery-prompt.ts:219', group: 'constant', usedBy: ['recovery'], inAtlasBefore: true },
    { key: 'TRUST_STORE_MAX_RECEIPTS / TRUST_STORE_MAX_BYTES', values: '512 / 262144', default: 'stałe', effect: 'Plik receiptów większy albo z więcej wpisami czyta się jako nieważny (brak zgody).', where: 'src/core/trust/receipt-store.ts:11; src/core/trust/receipt-store.ts:9', group: 'constant', usedBy: ['startup'], inAtlasBefore: false },
    { key: 'DETECTION cache: DEFAULT_TTL_MS / MAX_CACHE_ENTRIES / MAX_CACHED_MODELS_PER_ENTRY', values: '300000 / 100 / 500', default: 'stałe', effect: 'Ważność i pojemność detection-cache.json.', where: 'src/engine/detection/cache.ts:28; src/engine/detection/cache.ts:30; src/engine/detection/cache.ts:85', group: 'constant', usedBy: ['startup'], inAtlasBefore: false },
    { key: 'MODELS_DEV_CATALOG_CACHE_TTL_MS / MODELS_DEV_CATALOG_TIMEOUT_MS', values: '3600000 / 10000', default: 'stałe', effect: 'Ważność cache models.dev i limit pobrania.', where: 'src/engine/providers/models-dev-cache.ts:27', group: 'constant', usedBy: ['runners', 'subsystems'], inAtlasBefore: false },
    { key: 'MAX_CLI_CATALOG_READ_MODELS', values: '1000', default: 'stała', effect: 'Górny limit modeli czytanych z listy narzędzia CLI.', where: 'src/core/discovery/catalog-read-merge.ts:5', group: 'constant', usedBy: ['runners'], inAtlasBefore: false },
    { key: 'MAX_INPUT_HISTORY', values: '50', default: 'stała', effect: 'Ile promptów trzyma ~/.splitbrief/history.', where: 'src/stores/ui/input-history.ts:12', group: 'constant', usedBy: ['ui'], inAtlasBefore: false },
    { key: 'SECURE_FILE_MODE', values: '0o600', default: 'stała', effect: 'Tryb każdego pliku ustawień zapisywanego przez SPLITBRIEF (config.yaml, ui-prefs, history, receipty, cache). Config z bitami 0o022 daje ostrzeżenie.', where: 'src/lib/fs.ts:43; src/core/config/load/io.ts:94', group: 'constant', usedBy: ['startup'], inAtlasBefore: true },
    { key: 'DEFAULT_COMMAND_TIMEOUT_MS', values: '60000', default: 'stała', effect: 'Limit komend pomocniczych uruchamianych przez runCommand (np. git, formatter), gdy wywołujący nie poda własnego.', where: 'src/lib/process/spawn/run-command.ts:11', group: 'constant', usedBy: ['subsystems'], inAtlasBefore: false },
    { key: 'Środowisko dziecka: CHILD_RUNTIME_ENV_KEYS / CREDENTIAL_ACCESS_ENV_KEYS / CHILD_CONTROL_ENV_KEYS', values: 'listy nazw', default: 'stałe', effect: 'Runner CLI dostaje tylko klucze runtime (locale, TERM, NO_COLOR…) plus klucze kanału; komendy SPLITBRIEF (checki, rendery) dostają wszystko oprócz nazw poświadczeń i selektorów (AWS_PROFILE, SSH_AUTH_SOCK, GIT_SSH…). PATH tylko bezwzględny.', where: 'src/lib/process/spawn/child-env.ts:4; src/lib/process/spawn/child-env.ts:29; src/lib/process/spawn/child-env.ts:77', group: 'constant', usedBy: ['runners', 'review', 'build'], inAtlasBefore: true },
    { key: 'PROTECTED_PATHS_TEXT (ścieżki chronione)', values: 'manifesty i lockfile zależności, konfiguracja CI, pliki env i kluczy, .git, .splitbrief', default: 'stała', effect: 'Jedyne zapisy, które pytają użytkownika; approval.tiers nie zmienia tego zestawu.', where: 'src/core/pipeline-spec/scope.ts:2; src/core/schemas/enums.ts:230', group: 'constant', usedBy: ['build'], inAtlasBefore: true },
    { key: 'UNDO_RING_CAP / SPINNER_INTERVAL_MS', values: '200 / 120', default: 'stałe', effect: 'Głębokość cofania edytora i tempo spinnera (1000 ms przy reduce motion).', where: 'src/core/editor/editor-state.ts:62; src/hooks/use-spinner-frame.ts:5', group: 'constant', usedBy: ['ui'], inAtlasBefore: false }
  ],
  scenarios: [
    {
      title: 'Stary config z workflow.mode: speckit, approve: all i validation.typecheck: true',
      steps: [
        '1. loadConfig czyta plik; version: 3 przechodzi.',
        '2. Schemat trzyma workflow.mode i validation.typecheck jako z.unknown(); ApproveLevelSchema zamienia all na plan.',
        '3. retiredValueNotices zwraca trzy notice: o mode, o approve "all" (using "plan") i o validation.typecheck.',
        '4. emitEffectiveConfigWarnings wypisuje każdą raz na proces; raport readiness pokazuje je w sekcji ostrzeżeń.',
        '5. Run startuje z approve: plan i checkami wybieranymi przez reviewera.'
      ],
      outcome: 'Run działa jak na czystym configu; użytkownik widzi trzy linie z prośbą o usunięcie kluczy. Nic nie jest przepisywane w pliku.'
    },
    {
      title: 'CI z kluczem w zmiennej środowiskowej dla LM Studio',
      steps: [
        '1. config.yaml: implementer kind api, provider lm-studio, apiKey: env:LMS_TOKEN; w CI LMS_TOKEN nie jest wyeksportowany.',
        '2. validateConfig → apiKeyErrors → missingApiKeyError: parseApiKeyEnvRef daje LMS_TOKEN, process.env[LMS_TOKEN] puste.',
        '3. Błąd "implementer.apiKey: Environment variable LMS_TOKEN is not set (referenced by implementer.apiKey)." kończy ładowanie; exit 1 przed jakimkolwiek wywołaniem.',
        '4. Po wyeksportowaniu zmiennej ładowanie przechodzi; klucz jest czytany ponownie przy każdym wywołaniu (api-key.ts) i wysyłany tylko do originu apiBase.'
      ],
      outcome: 'Brak zmiennej to twardy błąd ładowania, nie ostrzeżenie; CI musi mieć sekret przed splitbrief start --json.'
    },
    {
      title: 'Flaga nadpisuje plik: splitbrief start --implementer codex --implementer-api-base http://x',
      steps: [
        '1. Plik ma implementer Ollama (api). Flagi dają overrides.implementer = { tool: codex, apiBase: http://x }.',
        '2. inferKindFromTool(codex) → cli (id z CLI_TOOL_IDS zawsze wybiera CLI).',
        '3. warnUnusableProviderOverrides: stderr "--implementer-api-base is ignored: \'codex\' selects the Codex CLI runner, which does not use it…".',
        '4. buildCliConfig buduje { kind: cli, tool: codex }; cel się zmienił, więc effort/variant z pliku znikają, timeout i fallback zostają.',
        '5. resolveEffectiveConfig waliduje wynik drugi raz; plik na dysku pozostaje bez zmian.'
      ],
      outcome: 'Run idzie na Codex CLI na jedno uruchomienie; apiBase jest ostrzeżeniem, nie błędem.'
    },
    {
      title: 'Headless --on-seat-down switch bez zadeklarowanego fallbacku',
      steps: [
        '1. splitbrief start "x" --json --on-seat-down switch; żaden seat nie ma fallback.',
        '2. withHeadlessStop: configDeclaresFallback(config) === false.',
        '3. cliError "`--on-seat-down switch` needs a seat that declares `fallback`; this config declares none." z kodem 2, zanim cokolwiek wystartuje.',
        '4. Bez flagi ten sam config startuje; przy Seat down run kończy się recovery_required i czeka na splitbrief continue --action.'
      ],
      outcome: 'Jawny switch wymaga fallbacku w pliku; brak flagi jest tolerancyjny.'
    },
    {
      title: 'Literówka validation.end_check: false w pliku',
      steps: [
        '1. fromYaml daje validation.endCheck (nieznany klucz).',
        '2. validation to z.object (nie strict), więc Zod nie zgłasza unrecognized_keys; klucz jest ignorowany bez słowa.',
        '3. resolveEndChecks czyta validation.endChecks → undefined → true.',
        '4. Reviewer wybiera i uruchamia checki, mimo że użytkownik chciał je wyłączyć.'
      ],
      outcome: 'Cicha literówka w bloku nie-strict. Ta sama literówka w workflow (strict) zakończyłaby ładowanie błędem z pełną ścieżką.'
    },
    {
      title: 'Settings zapisuje klucz, który plik ma w dwu pisowniach',
      steps: [
        '1. Blok planner w pliku ma linię output_format: text i niżej linię outputFormat: jsonl.',
        '2. loadedKey mapuje obie na outputFormat; przy ładowaniu późniejsza linia (jsonl) wygrywa.',
        '3. Zapis z TUI (applyConfigDocumentEdits) rozwiązuje ścieżkę do pisowni, którą loader czyta, usuwa wcześniejszego bliźniaka i edytuje późniejszy.',
        '4. transactConfigDocument sprawdza rewizję (sha256 + inode + mtime); zmiana pliku w międzyczasie daje conflict, nie nadpisanie.'
      ],
      outcome: 'Po zapisie plik ma jedną pisownię klucza; ręczna edycja równoległa jest wykrywana.'
    }
  ],
  files: [
    { path: 'src/core/schemas/config.ts', role: 'ConfigSchema: korzeń z.object, bloki strict (workflow, git, approval), retired jako z.unknown()' },
    { path: 'src/core/schemas/runner-fields.ts', role: 'pola per kind, GenerationCommonFields, fallback, refinements poświadczeń i watchdoga' },
    { path: 'src/core/schemas/implementer-config.ts', role: 'implementer, profile (label, capabilities.writesFiles), tabela profili' },
    { path: 'src/core/schemas/planner-config.ts', role: 'planner: model opcjonalny, guard capabilities dla shell/agent' },
    { path: 'src/core/schemas/reviewer-config.ts', role: 'reviewer: schemat planera z rolą reviewer' },
    { path: 'src/core/schemas/hooks.ts', role: 'HOOK_EVENTS, wpis hooka, zakazane launchery, retired commit events' },
    { path: 'src/core/schemas/codebase.ts', role: 'codebase z domyślnymi w schemacie' },
    { path: 'src/core/schemas/enums.ts', role: 'ApproveLevelSchema (retired → plan), EFFORT_LEVELS, OUTPUT_FORMATS, ISOLATION_STRATEGIES, RUNNER_KINDS' },
    { path: 'src/core/schemas/compaction.ts', role: 'CompactionFormatSchema i resolveCompactionFormat' },
    { path: 'src/core/config/custom-commands.ts', role: 'customCommands: schemat definicji, normalizacja tupla, duplikaty' },
    { path: 'src/core/config/load/io.ts', role: 'loadConfig, parseLoadedConfig, zapis atomowy z rewizją' },
    { path: 'src/core/config/load/defaults.ts', role: 'createDefaultConfig i mergeWithDefaults' },
    { path: 'src/core/config/load/transform.ts', role: 'snake_case ↔ camelCase, wyjątek dla hooks' },
    { path: 'src/core/config/load/document.ts', role: 'odczyt z O_NOFOLLOW, rewizja, resolveEditPath, .gitignore' },
    { path: 'src/core/config/load/validation/config.ts', role: 'validateConfig, usunięte klucze, retired notice, konflikt outputFormat' },
    { path: 'src/core/config/load/validation/credentials.ts', role: 'apiKeyErrors per seat i profil' },
    { path: 'src/core/config/load/validation/warnings.ts', role: 'ostrzeżenie {prompt} w argv' },
    { path: 'src/core/config/credentials.ts', role: 'env: prefix, reguły providera własnego i originu' },
    { path: 'src/core/config/runtime/effective-config.ts', role: 'resolveEffectiveConfig: flagi + druga walidacja + ostrzeżenia raz na proces' },
    { path: 'src/core/config/runtime/overrides/apply.ts', role: 'applyCLIOverrides: planner, implementer (profil domyślny), reviewer, effort' },
    { path: 'src/core/config/runtime/overrides/runner.ts', role: 'buildRunnerFromOverrides, ignorowane flagi api, --reviewer-effort przy REVIEW = PLAN' },
    { path: 'src/core/config/runtime/overrides/from-options.ts', role: 'WorkflowOpts → CLIOverrides (aliasy --model/--provider)' },
    { path: 'src/core/config/runtime/build-runner.ts', role: 'inferKindFromTool, co przenosi się przy zmianie celu' },
    { path: 'src/core/config/runtime/resolve.ts', role: 'resolveApproveLevel, resolveEndChecks, resolveApproveChecks' },
    { path: 'src/core/config/accessors/values.ts', role: 'getIsolationStrategy, applyEdits (Settings)' },
    { path: 'src/core/settings/catalog.ts', role: 'SETTINGS_DEFS: które klucze edytuje Settings i z jakimi etykietami' },
    { path: 'src/cli/options.ts', role: 'addWorkflowOptions: 46 opcji start/resume/continue, parsery' },
    { path: 'src/cli/unknown-command.ts', role: 'RETIRED_FLAGS: --mode, --approve, --yolo' },
    { path: 'src/core/pipeline-spec/bounds.ts', role: 'BOUNDS' },
    { path: 'src/core/pipeline-spec/timeouts.ts', role: 'TIMEOUTS' },
    { path: 'src/engine/providers/capabilities.ts', role: 'detectCapabilities: łańcuch źródeł contextLength' },
    { path: 'src/lib/process/spawn/child-env.ts', role: 'polityka środowiska dzieci' },
    { path: 'src/engine/runners/sandbox-env.ts', role: 'kanały auth, *_API_KEY passthrough, sandbox HOME' }
  ],
  gotchas: [
    'Klucze przyjmowane, ale nieczytane: workflow.showSpend (config.ts:104) i sessions.scope (config.ts:106). Żaden moduł poza schematem ich nie odczytuje. Dokumentacja podaje dla showSpend domyślne true, a dla sessions.scope project; kod nie ma domyślnej wartości, bo nic jej nie potrzebuje.',
    'customCommands.<id> jest walidowane (custom-commands.ts:293), ale żaden blok seatu nie ma pola, które wskazuje wpis po id. Jedynym czytelnikiem jest katalog zaufania (custom-command-catalog.ts), który dopasowuje tuple wykonawcze runnerów shell/agent do definicji.',
    'validation, sessions, palette i implementerProfiles są z.object, nie strictObject: literówka w nich przechodzi bez błędu i bez ostrzeżenia. Dokumentacja §15 wymienia tylko bloki strict (workflow, git, hooks, codebase, approval, runnery, PlannerCapabilities) i nie mówi, że validation jest tolerancyjne.',
    'Korzeń jest z.object, więc nieznany klucz główny jest ignorowany, z wyjątkiem sześciu nazw z REMOVED_TOP_LEVEL_KEYS, które są błędem.',
    'Konflikt outputFormat na antigravity, claude-code, codex, command-code, cursor jest błędem ładowania (validation/config.ts:72). Dokumentacja §2 kind: cli pisze „refuses before spawn”; przed spawn jest tylko druga blokada adaptera.',
    'docs/CONFIGURATION.md §14 opisuje --action jako skip, retry, switch-seat; kod przyjmuje też restore, end-run, apply i discard (options.ts:126). CLI-REFERENCE.md ma pełną listę.',
    'docs/CONFIGURATION.md §14 ogranicza --skills do start (headless), resume, continue; commander rejestruje flagę na wszystkich trzech bez warunku (options.ts:319), a interaktywny start nie czyta jej (streaming.ts:25 czyta, interactive.ts nie).',
    'Domyślne wartości mają dwa domy. W schemacie: compactionFormat auto, codebase.enabled true, codebase.tokenBudget 4000, hooks timeout_ms 30000, on_failure warn, approval.feedRejectionsToPlanner true. W akcesorach (??): approve plan, endChecks true, approveChecks auto, isolation worktree, validation.timeoutMs STAGE_TIMEOUT_MS, idleWarnMs 300000. mergeWithDefaults dopisuje do pliku tylko approve, review, compactionFormat, endChecks i blok implementera Ollama.',
    'temperature jest przyjmowane na każdym kind, ale nigdy nie trafia do serwera: polityka openai-compat pomija je, cli/shell/agent ostrzegają. Domyślny implementer Ollama ma mimo to temperature: 0.3 w pliku.',
    'env:VAR w apiKey jest sprawdzane przy ładowaniu (brak wartości = błąd), ale provider własny nie może go użyć w ogóle (exfiltration risk); provider z katalogu z własnym apiBase na innym originie też nie, gdy zmienna jest ustawiona.',
    'workflow.git.commitStrategy: none ładuje się bez notice i jest usuwane z załadowanego configu (transform), czego nie widać w żadnym komunikacie; checkpoint i per-task to błąd.',
    'hooks.pre_commit: [] i hooks.post_commit: [] ładują się i znikają; jedna pozycja w nich kończy ładowanie błędem.',
    'Flagi --<seat>-api-base i --<seat>-api-key-env na seat, którego cel nie jest api, są ignorowane z ostrzeżeniem na stderr, nie błędem. Id CLI zawsze wybiera CLI, więc provider własny o nazwie opencode jest osiągalny tylko z YAML.',
    'Zmiana celu seatu flagą (inny tool/provider) kasuje effort i variant z pliku, ale zachowuje timeout i fallback (build-runner.ts:150, :229).',
    'SPLITBRIEF_CONTEXT_LENGTH nadpisuje nawet jawne implementer.contextLength i dotyczy tylko profilu domyślnego.',
    'Ostrzeżenia konfiguracji (retired, uprawnienia 0o022, {prompt} w argv) są wypisywane raz na proces i projekt (toldNotices), więc kolejne resolve w tym samym procesie milczą.',
    'SPLITBRIEF_TEST_CLIPBOARD_CALLS jest dźwignią testową w kodzie produkcyjnym (native.ts:34): wydłuża timeout schowka do 15 s.',
    'Notice retired są liczone na surowym rekordzie po scaleniu z domyślnymi, więc approve: all raportuje się jako retired, mimo że załadowany config mówi plan.',
    'Plik ~/.splitbrief/trust/*.json z bitami grupy/innych (0o077) czyta się jako nieważny: zgoda znika po chmod 644.'
  ]
});
