window.ATLAS_REFACTOR = window.ATLAS_REFACTOR || [];
window.ATLAS_REFACTOR.push({
  part: 'engine',
  title: 'src/engine bez src/engine/orchestrator (runners, cli-tools, implementers, planners, reviewers, providers, calls, detection, streaming, spec, events, hooks, codebase, snapshots, parsers)',
  summary: `Ta część ma 283 pliki produkcyjne i 55344 linie (stan po synchronizacji z main 2026-10: liczba plików bez zmian, linie głównie z process-invoke.ts, events/schema.ts, plan-checks.ts). 56 plików ma ponad 300 linii, 24 ponad 500. Największe to runners/cli-tools/process-invoke.ts (1037, jedna funkcja invokeProcessCli ma 631 linii), events/schema.ts (900, jeden schemat), implementers/pipeline/run.ts (861, jedna fabryka createImplementerBase) i providers/model/catalog.ts (790). Główne problemy są trzy. (1) Płaskie foldery z grupami prefiksów: runners/ ma 35 plików (custom-*, sandbox-*), runners/cli-tools/ ma 27 (contract-harness-*, cli-probe-*, sondy w registry.ts), providers/ ma 32 (api-*, conformance-*, models-dev.ts obok folderu models-dev-cache/, cost-math.ts obok folderu cost/), streaming/ ma 18 (6 plików parse-*). Razem 25 grup prefiksów i par plik-obok-folderu. (2) Ta sama polityka napisana dwa lub trzy razy: rekorder i kolektor wywołań (limity, ostrzeżenia stderr), bezpieczeństwo komend sond (identyczny zbiór FORBIDDEN w detection/catalog-probe.ts i cli-tools/cli-probe-process.ts), pomocniki harnessu conformance (providers i cli-tools), strażnik przepisania pliku (extracted-code i apply-file-bundle), dwa czytniki rekordów Codex JSONL. Razem 17 klastrów duplikatów, 12 z domem w tej części. (3) Kilka plików ponad 500 linii łączy 3 do 5 odpowiedzialności. Zalecana kolejność: najpierw duplikaty o niskim ryzyku (RF_ENG_01 do RF_ENG_11, bez zmiany zachowania, mały zasięg), potem foldery bez dzielenia kodu (models-dev, cost, contract-harness, conformance, file-bundle), potem podziały dużych plików od najmniejszego zasięgu importów (arg-vector-preflight, runner-evidence, model/catalog, cost/breakdown), na końcu podziały wysokiego ryzyka (process-invoke, pipeline/run, resolve-cli-executable, prepared-execution). Po wszystkich propozycjach szacunkowo: ponad 500 linii zostaje 5 plików (wszystkie w keep), grup prefiksów zostaje około 7.`,
  stats: { files: 283, prodLines: 55344, over300: 56, over500: 24, prefixGroups: 25, duplicates: 17 },
  proposals: [
    {
      id: 'RF_ENG_01',
      kind: 'extract-shared',
      priority: 1,
      effort: 'S',
      risk: 'low',
      title: 'Jedna polityka limitów i ostrzeżeń stderr dla rekordera i kolektora wywołań',
      why: 'calls/recorder.ts (na żywo) i calls/collector.ts (odtwarzanie z eventów) piszą tę samą politykę dwa razy. Identyczne ciała: createTextLimiter (recorder.ts:753, collector.ts:465), itemLimit (recorder.ts:388, collector.ts:453), stderrLooksWarningLike z tym samym regexem (recorder.ts:407, collector.ts:493), budowa ostrzeżenia stderr_diagnostic/stderr_on_failure z tymi samymi polami (recorder.ts:411-432, collector.ts:497-517), doklejanie podglądu stderr przez sanitizeTerminalDiagnosticText (recorder.ts:400, collector.ts:480-486). Trzecia kopia fabryki limitera: streaming/parsed-line-recorder.ts:201 (createLiveLimiter, inny kod limitu). Zmiana progu albo tekstu ostrzeżenia w jednym miejscu rozjedzie wynik na żywo i wynik z logu.',
      before: [
        { path: 'src/engine/calls/recorder.ts', lines: 767, note: 'createRunnerCallRecorder + noteLimit, itemLimit, stderr*, createTextLimiter' },
        { path: 'src/engine/calls/collector.ts', lines: 523, note: 'collectRunnerCallResult + te same pomocniki na obiekcie stanu' },
        { path: 'src/engine/calls/output-limit.ts', lines: 296, note: 'createRunnerCallDeltaLimiter, runnerCallLimitWarning, runnerCallToolUseCountLimit' }
      ],
      after: [
        { path: 'src/engine/calls/output-limit.ts', lines: 320, note: '+ createRunnerCallTextLimiter(), runnerCallItemLimit(opts)' },
        { path: 'src/engine/calls/stderr-diagnostics.ts', lines: 50, note: 'stderrLooksWarningLike, stderrDiagnosticWarning(code, message), appendStderrPreview(preview, text)' },
        { path: 'src/engine/calls/recorder.ts', lines: 725, note: 'tylko maszyna stanu rekordera' },
        { path: 'src/engine/calls/collector.ts', lines: 475, note: 'tylko redukcja eventów do wyniku' }
      ],
      moves: [
        'createTextLimiter (recorder.ts:753, collector.ts:465) → output-limit.ts jako createRunnerCallTextLimiter',
        'itemLimit (recorder.ts:388, collector.ts:453) → output-limit.ts jako runnerCallItemLimit',
        'stderrLooksWarningLike (recorder.ts:407, collector.ts:493) → stderr-diagnostics.ts',
        'obiekt ostrzeżenia z emitStderrDiagnosticWarning (recorder.ts:411, collector.ts:497) → stderr-diagnostics.ts jako stderrDiagnosticWarning(code, message); oba pliki zostawiają tylko flagę stderrWarningEmitted i emit/appendWarning',
        'appendStderrPreview (recorder.ts:400) i kod podglądu w applyStderrEvent (collector.ts:480-486) → stderr-diagnostics.ts',
        'createLiveLimiter (parsed-line-recorder.ts:201) zostaje, ale woła createRunnerCallDeltaLimiter tak jak dziś (inny kod runner_output_text_limit) — bez zmiany'
      ],
      tests: 'recorder.test.ts i collector.test.ts zostają bez zmian i potwierdzają, że wynik na żywo i z logu jest ten sam. Nowy stderr-diagnostics.test.ts testuje regex i kształt ostrzeżenia bez rekordera. Dziś te reguły są testowalne tylko przez pełny rekorder albo pełny kolektor.',
      importers: 21,
      references: [ 'docs/PLANNERS-AND-IMPLEMENTERS.md:668' ],
      steps: [
        '1. Dodaj createRunnerCallTextLimiter i runnerCallItemLimit do calls/output-limit.ts.',
        '2. Utwórz calls/stderr-diagnostics.ts z trzema funkcjami.',
        '3. W recorder.ts i collector.ts usuń lokalne kopie, importuj nowe funkcje.',
        '4. npm run typecheck && npm run lint; potem testy calls/.'
      ],
      risks: 'Niskie: ciała są identyczne. Kolektor i rekorder różnią się tylko sposobem emisji (emit vs appendWarning), więc wspólny jest obiekt ostrzeżenia, a nie emisja. Kolejność ostrzeżeń w logu się nie zmienia. Łapie to collector.test.ts (porównanie z rekorderem).'
    },
    {
      id: 'RF_ENG_02',
      kind: 'extract-shared',
      priority: 1,
      effort: 'S',
      risk: 'low',
      title: 'Jedna reguła bezpieczeństwa komend sond CLI (nowy runners/cli-tools/probe/safety.ts)',
      why: 'Zbiór zakazanych argumentów sondy (download, exec, install, login, pull, refresh, run, sync, update, upgrade) jest skopiowany: FORBIDDEN_PROBE_ARGUMENTS (cli-tools/cli-probe-process.ts:30) i FORBIDDEN_CATALOG_PROBE_ARGUMENTS (detection/catalog-probe.ts:74). Tak samo funkcja sprawdzająca (hasForbiddenProbeArgument cli-probe-process.ts:209, hasForbiddenCatalogArgument catalog-probe.ts:114), probeCommandsMatch (cli-probe-process.ts:240, catalog-probe.ts:124), ścieżka PATH sondy (probeRuntimePath cli-probe-process.ts:62, catalogRuntimePath catalog-probe.ts:293) i zamrożenie argv (ownedProbeCommand registry.ts:348, immutableProbeCommand catalog-probe.ts:170). To polityka bezpieczeństwa: dopisanie słowa do jednej listy zostawia drugą otwartą.',
      before: [
        { path: 'src/engine/runners/cli-tools/cli-probe-process.ts', lines: 270, note: 'FORBIDDEN_PROBE_ARGUMENTS, probeRuntimePath, hasForbiddenProbeArgument, probeCommandsMatch' },
        { path: 'src/engine/detection/catalog-probe.ts', lines: 579, note: 'FORBIDDEN_CATALOG_PROBE_ARGUMENTS, hasForbiddenCatalogArgument, probeCommandsMatch, catalogRuntimePath, immutableProbeCommand' },
        { path: 'src/engine/runners/cli-tools/registry.ts', lines: 649, note: 'ownedProbeCommand' }
      ],
      after: [
        { path: 'src/engine/runners/cli-tools/probe/safety.ts', lines: 70, note: 'FORBIDDEN_PROBE_ARGUMENTS, hasForbiddenProbeArgument, probeCommandsMatch, probeRuntimePath, ownedProbeCommand' },
        { path: 'src/engine/runners/cli-tools/cli-probe-process.ts', lines: 225, note: 'bez kopii' },
        { path: 'src/engine/detection/catalog-probe.ts', lines: 530, note: 'bez kopii; dalszy podział w RF_ENG_14' }
      ],
      moves: [
        'FORBIDDEN_PROBE_ARGUMENTS + FORBIDDEN_CATALOG_PROBE_ARGUMENTS → probe/safety.ts jako jeden FORBIDDEN_PROBE_ARGUMENTS',
        'hasForbiddenProbeArgument + hasForbiddenCatalogArgument → probe/safety.ts (sygnatura z catalog-probe: Readonly<{ command: readonly string[] }>, pasuje do obu)',
        'probeCommandsMatch ×2 → probe/safety.ts (sygnatura pozycyjna z catalog-probe)',
        'probeRuntimePath + catalogRuntimePath → probe/safety.ts jako probeRuntimePath',
        'ownedProbeCommand (registry.ts:348) + immutableProbeCommand (catalog-probe.ts:170) → probe/safety.ts jako ownedProbeCommand'
      ],
      tests: 'catalog-probe.test.ts, catalog-probe-failure.integration.test.ts, readiness-probe.integration.test.ts, registry.test.ts zostają. Nowy probe/safety.test.ts testuje listę zakazów i porównanie argv bez spawnu procesu; dziś to wymaga sondy.',
      importers: 3,
      references: [ 'docs/SUBSYSTEMS.md:89' ],
      steps: [
        '1. Utwórz runners/cli-tools/probe/safety.ts z pięcioma eksportami.',
        '2. Zastąp kopie w cli-probe-process.ts, catalog-probe.ts i registry.ts importem.',
        '3. Usuń stałe i funkcje lokalne. npm run typecheck && npm run lint.',
        '4. Testy detection/ i runners/cli-tools/.'
      ],
      risks: 'Niskie. detection importuje już z runners/cli-tools (readiness-probe.ts), więc kierunek warstw bez zmian. Wyjątek codex login status (isExactCodexLoginStatusProbe) zostaje w cli-probe-process.ts, bo dotyczy tylko sondy auth.'
    },
    {
      id: 'RF_ENG_03',
      kind: 'extract-shared',
      priority: 1,
      effort: 'M',
      risk: 'low',
      title: 'Wspólny dom dowodów kandydata: podział providers/candidate-contract.ts na providers/candidate/',
      why: 'providers/candidate-contract.ts (607) łączy trzy rzeczy: schemat kontraktu kandydata (16-383), schemat dowodu i jego sanitację (384-535) oraz pokwitowanie efektu (536-607). Oba harnessy conformance kopiują pomocniki dowodu: ConformanceErrorCode + throwConformance + hasConformanceCode (providers/conformance.ts:47-59, cli-tools/contract-harness.ts:87-104), redakcja wartości poświadczeń replaceAll(credential, [REDACTED]) (conformance.ts:71, contract-harness.ts:111), zapis pliku dowodu mkdir+writeFile 0o600 (conformance-raw.ts:160, conformance-production.ts:39, contract-harness.ts:280), odczyt rekordu rawCapture (conformance-production.ts:173, contract-harness-production.ts:65). Oba harnessy już importują candidate-contract.ts, więc to jest naturalny dom.',
      before: [
        { path: 'src/engine/providers/candidate-contract.ts', lines: 607, note: 'kontrakt + dowód + efekt' },
        { path: 'src/engine/providers/conformance.ts', lines: 159, note: 'kopie throwConformance, hasConformanceCode, redactWithCredentials' },
        { path: 'src/engine/runners/cli-tools/contract-harness.ts', lines: 285, note: 'kopie throwConformance, hasConformanceCode, redactOutput, writeEvidenceFile' }
      ],
      after: [
        { path: 'src/engine/providers/candidate/contract.ts', lines: 375, note: 'jeden schemat: RawProviderCandidateContract, EndpointPolicySchema, UnregisteredProviderCandidate, CONFORMANCE_PROMPT, baseUrlEnvironmentName, requiresLiveModelDiscovery' },
        { path: 'src/engine/providers/candidate/evidence.ts', lines: 165, note: 'CandidateEvidence, MAX_EVIDENCE_OUTPUT_BYTES, CONFORMANCE_EXIT_CODES, canonicalJson, contractSha256, sanitizeCandidateOutput, createCandidateEvidenceCapture, normalizeCandidateEvidence' },
        { path: 'src/engine/providers/candidate/harness.ts', lines: 90, note: 'ConformanceErrorCode, throwConformance, hasConformanceCode, redactWithCredentials, writeEvidenceFile, readRawCaptureRecord(path, { standalone })' },
        { path: 'src/engine/providers/candidate/effect.ts', lines: 75, note: 'CandidateEffectReceipt, admitCandidateEffect (albo RF_ENG_34)' }
      ],
      moves: [
        'linie 16-383 candidate-contract.ts → candidate/contract.ts',
        'linie 384-535 (CandidateEvidence … normalizeCandidateEvidence) + MAX_EVIDENCE_OUTPUT_BYTES + CONFORMANCE_EXIT_CODES → candidate/evidence.ts',
        'linie 536-607 → candidate/effect.ts',
        'throwConformance, hasConformanceCode, ConformanceErrorCode z conformance.ts:47-59 i contract-harness.ts:87-104 → candidate/harness.ts',
        'redactWithCredentials (conformance.ts:71) + redactOutput (contract-harness.ts:111) → candidate/harness.ts jako redactWithCredentials',
        'writeEvidenceFile (contract-harness.ts:280) → candidate/harness.ts; writeRawRecord w conformance-raw.ts:160 i writeProductionRecord w conformance-production.ts:39 wołają go',
        'readRawRecord (conformance-production.ts:173, contract-harness-production.ts:65) → candidate/harness.ts jako readRawCaptureRecord(path, { label, standalone }); wersja CLI wymaga standalone (Object.keys(parsed).length === 1)'
      ],
      tests: 'candidate-contract.test.ts dzieli się na candidate/contract.test.ts i candidate/evidence.test.ts. testing/architecture/candidate-contract.test.ts zmienia import. Nowy candidate/harness.test.ts testuje odczyt i zapis rekordu bez sieci i bez procesu CLI; dziś ten kod jest testowany tylko przez conformance.test.ts i contract-harness-production.test.ts.',
      importers: 26,
      references: [ 'scripts/invariants/gates.ts:256', 'docs/INVARIANTS.md:50', 'docs/ARCHITECTURE.md:657' ],
      steps: [
        '1. Utwórz providers/candidate/ i przenieś linie do contract.ts, evidence.ts, effect.ts.',
        '2. Utwórz candidate/harness.ts z pomocnikami; usuń kopie z conformance.ts i contract-harness.ts.',
        '3. Zmień 26 importerów (16 prod) z providers/candidate-contract.js na właściwy plik.',
        '4. Bramka 33: zmień wzorzec ^src/engine/providers/candidate-contract.ts: na ^src/engine/providers/candidate/contract.ts: (privacyURL/termsURL są w ApiProviderDescriptorSchema, linie 228-266). Zaktualizuj wiersz 33 w docs/INVARIANTS.md.',
        '5. npm run typecheck && npm run lint && npm run check:invariants; potem testy providers/ i cli-tools/.'
      ],
      risks: 'Bramka 33 (scripts/invariants/gates.ts:256) trzyma ścieżkę dosłownie: bez zmiany wzorca bramka zgłosi privacyURL. Komunikaty błędów odczytu rekordu różnią się słowem (provider vs CLI), więc readRawCaptureRecord bierze etykietę. Łapie to check:invariants i conformance.test.ts.'
    },
    {
      id: 'RF_ENG_04',
      kind: 'folderize',
      priority: 1,
      effort: 'S',
      risk: 'low',
      title: 'contract-harness-*.ts → runners/cli-tools/contract-harness/',
      why: 'Pięć plików z prefiksem contract-harness (contract-harness.ts 285, -raw 266, -production 421, -cwd 267, -effects 285; razem 1524 linie) leży płasko w cli-tools/ obok 22 plików adapterów i sond. Prod importuje z nich tylko src/cli/commands/doctor.ts; reszta to scripts/cli-conformance.ts i testy.',
      before: [
        { path: 'src/engine/runners/cli-tools/contract-harness.ts', lines: 285, note: 'typy, procesy ograniczone, projekt tymczasowy' },
        { path: 'src/engine/runners/cli-tools/contract-harness-raw.ts', lines: 266, note: 'runRawCliConformance' },
        { path: 'src/engine/runners/cli-tools/contract-harness-production.ts', lines: 421, note: 'runProductionCliConformance' },
        { path: 'src/engine/runners/cli-tools/contract-harness-cwd.ts', lines: 267, note: 'runCwdCliConformance' },
        { path: 'src/engine/runners/cli-tools/contract-harness-effects.ts', lines: 285, note: 'runFactoryEffectConformance' }
      ],
      after: [
        { path: 'src/engine/runners/cli-tools/contract-harness/harness.ts', lines: 260, note: 'po RF_ENG_03 bez kopii pomocników' },
        { path: 'src/engine/runners/cli-tools/contract-harness/raw.ts', lines: 262, note: 'bez lokalnego writeRawRecord' },
        { path: 'src/engine/runners/cli-tools/contract-harness/production.ts', lines: 398, note: 'bez lokalnego readRawRecord' },
        { path: 'src/engine/runners/cli-tools/contract-harness/cwd.ts', lines: 267, note: '' },
        { path: 'src/engine/runners/cli-tools/contract-harness/effects.ts', lines: 285, note: '' }
      ],
      moves: [ 'contract-harness.ts → contract-harness/harness.ts', 'contract-harness-raw.ts → contract-harness/raw.ts', 'contract-harness-production.ts → contract-harness/production.ts', 'contract-harness-cwd.ts → contract-harness/cwd.ts', 'contract-harness-effects.ts → contract-harness/effects.ts' ],
      tests: 'Przenoszą się: contract-harness-raw.test.ts → contract-harness/raw.test.ts, contract-harness-production.test.ts → production.test.ts, contract-harness-cwd.test.ts → cwd.test.ts, contract-harness-effects.integration.test.ts → effects.integration.test.ts. existing-contract.test.ts zostaje w cli-tools/ (testuje adaptery) i zmienia import.',
      importers: 6,
      references: [ 'scripts/cli-conformance.ts:9', 'scripts/cli-conformance.ts:10', 'scripts/cli-conformance.ts:11', 'scripts/cli-conformance.ts:12', 'docs/PLANNERS-AND-IMPLEMENTERS.md:61', 'docs/PLANNERS-AND-IMPLEMENTERS.md:632', 'docs/TESTING.md:174', 'testing/helpers/factories/cli-effect-fixture.ts (import)' ],
      steps: [ '1. git mv pięciu plików i czterech testów do contract-harness/.', '2. Popraw importy względne w przeniesionych plikach (o jeden poziom głębiej).', '3. Zmień importy w doctor.ts, scripts/cli-conformance.ts, existing-contract.test.ts, testing/helpers/factories/cli-effect-fixture.ts, testing/integration/orchestrator/planner-effect-matrix.test.ts, runner-capability-matrix.test.ts.', '4. Popraw ścieżki w docs. npm run typecheck && npm run lint.' ],
      risks: 'Niskie. knip.json:4 wskazuje scripts/cli-conformance.ts jako entry, więc graf knip podąży za importem. Łapie to typecheck.'
    },
    {
      id: 'RF_ENG_05',
      kind: 'folderize',
      priority: 1,
      effort: 'S',
      risk: 'low',
      title: 'conformance*.ts w providers/ → providers/conformance/',
      why: 'Trzy pliki z prefiksem conformance (conformance.ts 159, conformance-raw.ts 264, conformance-production.ts 276) leżą w płaskim providers/ (32 pliki). To narzędzie dla scripts/provider-conformance.ts; w prod importuje je tylko unregistered-provider.ts. Lustro RF_ENG_04 dla dostawców API.',
      before: [
        { path: 'src/engine/providers/conformance.ts', lines: 159, note: 'typy i pomocniki' },
        { path: 'src/engine/providers/conformance-raw.ts', lines: 264, note: 'runRawProviderConformance' },
        { path: 'src/engine/providers/conformance-production.ts', lines: 276, note: 'runProductionProviderConformance' }
      ],
      after: [
        { path: 'src/engine/providers/conformance/shared.ts', lines: 135, note: 'po RF_ENG_03 bez kopii pomocników' },
        { path: 'src/engine/providers/conformance/raw.ts', lines: 258, note: '' },
        { path: 'src/engine/providers/conformance/production.ts', lines: 250, note: 'bez readRawRecord i zapisu pliku' }
      ],
      moves: [ 'conformance.ts → conformance/shared.ts', 'conformance-raw.ts → conformance/raw.ts', 'conformance-production.ts → conformance/production.ts' ],
      tests: 'conformance.test.ts → conformance/shared.test.ts; conformance-replay.test.ts → conformance/production-replay.test.ts.',
      importers: 3,
      references: [ 'scripts/provider-conformance.ts:2', 'scripts/provider-conformance.ts:3', 'scripts/provider-conformance.ts:4', 'docs/EXTENDING.md:281', 'docs/ARCHITECTURE.md:659' ],
      steps: [ '1. git mv trzech plików i dwóch testów.', '2. Popraw importy względne i import w unregistered-provider.ts.', '3. Popraw scripts/provider-conformance.ts i docs/EXTENDING.md:281.', '4. npm run typecheck && npm run lint.' ],
      risks: 'Niskie; łapie to typecheck. Nazwa shared.ts zamiast conformance.ts, żeby nie powtarzać nazwy folderu.'
    },
    {
      id: 'RF_ENG_06',
      kind: 'folderize',
      priority: 1,
      effort: 'S',
      risk: 'low',
      title: 'models-dev.ts + models-dev-cache.ts + models-dev-cache/ → providers/models-dev/',
      why: 'Jeden podsystem leży w trzech miejscach: providers/models-dev.ts (337, katalog i wyszukiwanie), providers/models-dev-cache.ts (242, wejście cache) i folder providers/models-dev-cache/ (store.ts 319, fetch.ts 88, parse.ts 51, record.ts 59, parse-worker.ts 8). To jest zapach plik obok folderu z tą samą treścią.',
      before: [
        { path: 'src/engine/providers/models-dev.ts', lines: 337, note: 'fetchModelsDevCatalog, findCatalogModelByIdentity, getModelsForProvider' },
        { path: 'src/engine/providers/models-dev-cache.ts', lines: 242, note: 'loadModelsDevCatalogCache, refreshModelsDevCatalogCache' },
        { path: 'src/engine/providers/models-dev-cache/', lines: 525, note: 'store, fetch, parse, record, parse-worker' }
      ],
      after: [
        { path: 'src/engine/providers/models-dev/catalog.ts', lines: 337, note: 'dawny models-dev.ts' },
        { path: 'src/engine/providers/models-dev/cache.ts', lines: 242, note: 'dawny models-dev-cache.ts' },
        { path: 'src/engine/providers/models-dev/store.ts', lines: 319, note: '' },
        { path: 'src/engine/providers/models-dev/fetch.ts', lines: 88, note: '' },
        { path: 'src/engine/providers/models-dev/parse.ts', lines: 51, note: 'new URL(./parse-worker.*) zostaje względny' },
        { path: 'src/engine/providers/models-dev/record.ts', lines: 59, note: '' },
        { path: 'src/engine/providers/models-dev/parse-worker.ts', lines: 8, note: '' }
      ],
      moves: [ 'models-dev.ts → models-dev/catalog.ts', 'models-dev-cache.ts → models-dev/cache.ts', 'models-dev-cache/{store,fetch,parse,record,parse-worker}.ts → models-dev/' ],
      tests: 'models-dev.test.ts → models-dev/catalog.test.ts, models-dev-cache.test.ts → models-dev/cache.test.ts, models-dev-cache/parse.integration.test.ts → models-dev/parse.integration.test.ts.',
      importers: 15,
      references: [ 'scripts/invariants/gates.ts:256', 'docs/INVARIANTS.md:50', 'docs/EXTENDING.md:165', 'docs/SUBSYSTEMS.md:85', 'docs/ARCHITECTURE.md:664' ],
      steps: [ '1. git mv plików i testów.', '2. Zmień importy w 15 plikach (src/cli/bootstrap/discovery.ts, src/stores/discovery/detection-adapter.ts, evals/runner.ts, detection/*, model/*).', '3. Bramka 33: wzorzec ^src/engine/providers/models-dev\\.ts: → ^src/engine/providers/models-dev/catalog\\.ts: (albo ^src/engine/providers/models-dev/).', '4. npm run typecheck && npm run lint && npm run check:invariants.' ],
      risks: 'Bramka 33 nazywa plik dosłownie; bez zmiany wzorca zgłosi fetchWithTimeout w nowym miejscu. parse-worker ładuje się przez new URL względem import.meta.url, więc musi zostać w tym samym folderze co parse.ts. Łapie to check:invariants i parse.integration.test.ts.'
    },
    {
      id: 'RF_ENG_07',
      kind: 'move',
      priority: 1,
      effort: 'S',
      risk: 'low',
      title: 'cost-math.ts i pricing-resolver.ts do providers/cost/',
      why: 'providers/cost-math.ts (249) leży obok folderu providers/cost/ i importują go tylko pliki cost/ (breakdown, request-estimates, task-usage). pricing-resolver.ts (220) importują cost/* (3), cost-math i model/catalog.ts. To jest zapach plik obok folderu z tą samą treścią.',
      before: [
        { path: 'src/engine/providers/cost-math.ts', lines: 249, note: 'calculateCost, calculateUsageCost, recordProviderCost, resolveTaskPricingModel' },
        { path: 'src/engine/providers/pricing-resolver.ts', lines: 220, note: 'resolvePricing, getPricingMode, LOCAL_PRICING' }
      ],
      after: [
        { path: 'src/engine/providers/cost/math.ts', lines: 249, note: '' },
        { path: 'src/engine/providers/cost/pricing.ts', lines: 220, note: '' }
      ],
      moves: [ 'cost-math.ts → cost/math.ts', 'pricing-resolver.ts → cost/pricing.ts' ],
      tests: 'cost-math.test.ts → cost/math.test.ts, pricing-resolver.test.ts → cost/pricing.test.ts.',
      importers: 6,
      references: [ 'docs/ARCHITECTURE.md:660', 'docs/ARCHITECTURE.md:666', 'docs/EXTENDING.md:165', 'docs/FEATURES.md:291', 'docs/PLANNERS-AND-IMPLEMENTERS.md:420' ],
      steps: [ '1. git mv dwóch plików i dwóch testów.', '2. Popraw importy w cost/*, model/catalog.ts.', '3. Popraw docs. npm run typecheck && npm run lint.' ],
      risks: 'Niskie; łapie to typecheck.'
    },
    {
      id: 'RF_ENG_08',
      kind: 'folderize',
      priority: 1,
      effort: 'M',
      risk: 'low',
      title: 'Pliki file-bundle → implementers/file-bundle/ + jeden strażnik przepisania pliku',
      why: 'Cztery pliki jednego kontraktu leżą płasko z różnym szykiem nazw: file-bundle.ts, parse-file-bundle.ts, apply-file-bundle.ts, bundle-baseline.ts. Strażnik przepisania jest skopiowany: MIN_GUARDED_BASELINE_LINES = 5, MAX_WHOLE_FILE_SHRINK = 0.5, countNonEmptyLines i warunek had < MIN || kept >= had * MAX (pipeline/extracted-code.ts:11-26, apply-file-bundle.ts:11-55). byPath jest trzy razy (bundle-baseline.ts:35, parse-file-bundle.ts:43, apply-file-bundle.ts:32), message(err) dwa razy (bundle-baseline.ts:48, apply-file-bundle.ts:37). implementers/apply.ts (applyCode, hasApplicablePatch) importuje tylko pipeline/extracted-code.ts.',
      before: [
        { path: 'src/engine/implementers/file-bundle.ts', lines: 130, note: 'FileBundleSchema, BuildOutputContract, selectBuildOutputContract, BundleBaseline' },
        { path: 'src/engine/implementers/parse-file-bundle.ts', lines: 212, note: 'parseFileBundle, unsafePathReason' },
        { path: 'src/engine/implementers/apply-file-bundle.ts', lines: 284, note: 'applyFileBundle + kopia strażnika' },
        { path: 'src/engine/implementers/bundle-baseline.ts', lines: 213, note: 'captureBundleBaseline, compareBundleBaseline' },
        { path: 'src/engine/implementers/apply.ts', lines: 156, note: 'applyCode (SEARCH/REPLACE)' },
        { path: 'src/engine/implementers/pipeline/extracted-code.ts', lines: 107, note: 'kopia strażnika' }
      ],
      after: [
        { path: 'src/engine/implementers/file-bundle/contract.ts', lines: 138, note: 'dawny file-bundle.ts + compareBundlePaths (byPath)' },
        { path: 'src/engine/implementers/file-bundle/parse.ts', lines: 205, note: '' },
        { path: 'src/engine/implementers/file-bundle/apply.ts', lines: 265, note: 'woła rewrite-guard' },
        { path: 'src/engine/implementers/file-bundle/baseline.ts', lines: 205, note: '' },
        { path: 'src/engine/implementers/rewrite-guard.ts', lines: 25, note: 'MIN_GUARDED_BASELINE_LINES, MAX_WHOLE_FILE_SHRINK, countNonEmptyLines, isImplausibleShrink(baseline, candidate)' },
        { path: 'src/engine/implementers/pipeline/apply-code.ts', lines: 156, note: 'dawny implementers/apply.ts' },
        { path: 'src/engine/implementers/pipeline/extracted-code.ts', lines: 98, note: 'woła rewrite-guard' }
      ],
      moves: [
        'file-bundle.ts → file-bundle/contract.ts',
        'parse-file-bundle.ts → file-bundle/parse.ts',
        'apply-file-bundle.ts → file-bundle/apply.ts',
        'bundle-baseline.ts → file-bundle/baseline.ts',
        'byPath ×3 → file-bundle/contract.ts jako compareBundlePaths',
        'MIN_GUARDED_BASELINE_LINES, MAX_WHOLE_FILE_SHRINK, countNonEmptyLines i warunek kurczenia z extracted-code.ts:11-26 i apply-file-bundle.ts:11-55 → implementers/rewrite-guard.ts; teksty odmowy zostają w wołających (różnią się radą)',
        'implementers/apply.ts → pipeline/apply-code.ts (jedyny importer to extracted-code.ts)'
      ],
      tests: 'parse-file-bundle.test.ts → file-bundle/parse.test.ts, apply-file-bundle.test.ts → file-bundle/apply.test.ts, bundle-baseline.test.ts → file-bundle/baseline.test.ts, file-bundle-contract.test.ts → file-bundle/contract.test.ts, apply.test.ts → pipeline/apply-code.test.ts; api-file-bundle.test.ts zostaje (testuje implementers/api.ts). Nowy rewrite-guard.test.ts testuje próg raz dla obu ścieżek; dziś próg jest testowany osobno w dwóch plikach.',
      importers: 21,
      references: [ 'docs/ARCHITECTURE.md (drzewo implementers/ nie wymienia tych plików — bez zmiany)' ],
      steps: [ '1. Utwórz implementers/rewrite-guard.ts; przepnij extracted-code.ts i apply-file-bundle.ts.', '2. git mv czterech plików do file-bundle/ i apply.ts do pipeline/apply-code.ts razem z testami.', '3. Zmień importy w 21 plikach (12 prod: m.in. orchestrator/context-routing/*, orchestrator/evidence/*, orchestrator/task/commit.ts, spec/prompt-formatter.ts, spec/prompts/system.ts; testing/helpers/target-write-fixtures.ts).', '4. npm run typecheck && npm run lint; testy implementers/ i orchestrator/task.' ],
      risks: 'Zasięg wchodzi do orchestrator/ (12 importerów prod, część w części orchestrator) — trzeba to uzgodnić z właścicielem tamtej części. Zachowanie bez zmian. Łapie to typecheck.'
    },
    {
      id: 'RF_ENG_09',
      kind: 'extract-shared',
      priority: 1,
      effort: 'S',
      risk: 'low',
      title: 'Wartości poświadczeń ze środowiska: jeden dom w runners/sandbox-credential-values.ts',
      why: 'Wybór wartości poświadczeń ze środowiska jest napisany dwa razy: credentialValuesFromEnvironment (streaming/spawn-collect.ts:401) i selectedCredentialValues (runners/cli-tools/process-invoke.ts:931; ta sama logika plus nazwy z descriptor.auth.channels). Doczepienie nieliczalnej własności SANDBOX_CREDENTIAL_VALUES do nowego obiektu env jest napisane trzy razy: sandbox-env.ts:65, sandbox-env.ts:343, invoke-cli-adapter.ts:35. To kod redakcji sekretów; rozjechanie kopii zostawi sekret w logu.',
      before: [
        { path: 'src/engine/runners/sandbox-credential-values.ts', lines: 53, note: 'SANDBOX_CREDENTIAL_VALUES, sandboxCredentialValues' },
        { path: 'src/engine/streaming/spawn-collect.ts', lines: 434, note: 'credentialValuesFromEnvironment' },
        { path: 'src/engine/runners/cli-tools/process-invoke.ts', lines: 1037, note: 'selectedCredentialValues' }
      ],
      after: [
        { path: 'src/engine/runners/sandbox-credential-values.ts', lines: 90, note: '+ credentialValuesFromEnvironment(env, declaredNames?), withSandboxCredentialValues(target, values)' }
      ],
      moves: [
        'credentialValuesFromEnvironment (spawn-collect.ts:401) + selectedCredentialValues (process-invoke.ts:931) → sandbox-credential-values.ts jako credentialValuesFromEnvironment(environment, declaredNames = [])',
        'Object.defineProperty(result, SANDBOX_CREDENTIAL_VALUES, …) ×3 (sandbox-env.ts:65, :343, invoke-cli-adapter.ts:35) → withSandboxCredentialValues(target, values)'
      ],
      tests: 'sandbox-env.test.ts, spawn-collect.integration.test.ts, process-invoke.integration.test.ts zostają. Nowy sandbox-credential-values.test.ts testuje wybór nazw i nieliczalność własności bez spawnu.',
      importers: 11,
      references: [],
      steps: [ '1. Dodaj dwie funkcje do sandbox-credential-values.ts.', '2. Przepnij spawn-collect.ts, process-invoke.ts, sandbox-env.ts, invoke-cli-adapter.ts.', '3. Usuń eksport credentialValuesFromEnvironment ze spawn-collect.ts (nikt go nie importuje z zewnątrz).', '4. npm run typecheck && npm run lint.' ],
      risks: 'Niskie. Różnica: wersja ze spawn-collect pomija puste wartości (value.length > 0), wersja z process-invoke nie — wspólna funkcja musi pomijać puste (pusty łańcuch nie jest sekretem, a redakcja pustego łańcucha nic nie zmienia). Łapie to process-invoke.integration.test.ts.'
    },
    {
      id: 'RF_ENG_10',
      kind: 'delete-dead',
      priority: 1,
      effort: 'S',
      risk: 'low',
      title: 'Usunąć cztery reeksporty w engine (zasada NO-BARRELS)',
      why: 'docs/NO-BARRELS.md usuwa jednolinijkowe reeksporty typów (Batch 1A). W tej części zostały cztery: spec/prompt-formatter.ts:17 export { formatImplementerSystemPreamble } (alias buildImplementerSystemPreamble z prompts/system.ts), providers/dispatch-stream.ts:10 export type { StreamMessage } (nikt go nie importuje stąd), detection/service.ts:41 export type { DetectionProjection } (nikt go nie importuje stąd; coordinator.ts i stores importują z detection/types.ts), hooks/types.ts:6 export type { HookOutcome } z core/schemas/hooks.ts (dispatch.ts i sink.ts czytają go przez hooks/types.ts).',
      before: [
        { path: 'src/engine/spec/prompt-formatter.ts', lines: 362, note: 'reeksport aliasu' },
        { path: 'src/engine/providers/dispatch-stream.ts', lines: 76, note: 'martwy reeksport' },
        { path: 'src/engine/detection/service.ts', lines: 565, note: 'martwy reeksport' },
        { path: 'src/engine/hooks/types.ts', lines: 13, note: 'reeksport z core' }
      ],
      after: [
        { path: 'src/engine/spec/prompt-formatter.ts', lines: 360, note: 'bez aliasu; wołający importują buildImplementerSystemPreamble z prompts/system.ts' },
        { path: 'src/engine/hooks/types.ts', lines: 12, note: 'bez reeksportu' }
      ],
      moves: [
        'formatImplementerSystemPreamble: estimation.ts, assessment.ts (orchestrator/context-routing), implementers/pipeline/run.ts, estimation.test.ts, prompt-formatter.test.ts → import buildImplementerSystemPreamble z spec/prompts/system.js',
        'usunąć dispatch-stream.ts:10 i detection/service.ts:41',
        'HookOutcome: hooks/dispatch.ts:11 i hooks/sink.ts:6 → import z core/schemas/hooks.js'
      ],
      tests: 'Bez zmian w zachowaniu; testy zmieniają tylko import.',
      importers: 7,
      references: [ 'docs/PLANNERS-AND-IMPLEMENTERS.md:301 (nazwa formatImplementerSystemPreamble)' ],
      steps: [ '1. Usuń dwa martwe reeksporty.', '2. Przepnij 5 importów formatImplementerSystemPreamble i 2 importy HookOutcome.', '3. Popraw nazwę w docs/PLANNERS-AND-IMPLEMENTERS.md:301.', '4. npm run typecheck && npm run lint.' ],
      risks: 'Niskie. Dwa importery są w orchestrator/ (inna część) — zmiana jednej linii importu.'
    },
    {
      id: 'RF_ENG_11',
      kind: 'extract-shared',
      priority: 1,
      effort: 'S',
      risk: 'low',
      title: 'Drobne duplikaty w engine: typ walidacji argumentów, kanał tekstu wyniku, firstString, komunikat braku CLI',
      why: 'Cztery małe kopie z domem w tej części. (a) Typ CliArgumentValidation jest zdefiniowany trzy razy: cli-tools/validate-args.ts:4 (eksport), cli-tools/candidate-contract.ts:94, cli-tools/process-invoke.ts:888. (b) Predykat kanału, który daje tekst wyniku (assistant | result | stdout), jest trzy razy: calls/collector.ts:519, streaming/parsed-line-recorder.ts:197, runners/invoke-cli-adapter.ts:208 (contributesToStreamedText). (c) firstString jest identyczna w streaming/parse-jsonl.ts:59 i streaming/parse-stream-json.ts:216. (d) cliNotFoundMessage jest w planners/cli.ts:40 (… not found. See <url>) i implementers/cli.ts:36 (… not found. Install it from <url>) z różnym tekstem dla tego samego stanu.',
      before: [
        { path: 'src/engine/runners/cli-tools/validate-args.ts', lines: 196, note: 'CliArgumentValidation' },
        { path: 'src/engine/calls/types.ts', lines: 27, note: '' }
      ],
      after: [
        { path: 'src/engine/runners/cli-tools/validate-args.ts', lines: 225, note: '+ normalizeCliArgumentValidation, formatArgumentConflicts (z process-invoke.ts:892-918)' },
        { path: 'src/engine/calls/result-text.ts', lines: 10, note: 'contributesToResultText(channel)' },
        { path: 'src/engine/streaming/parse/fields.ts', lines: 10, note: 'firstString (po RF_ENG_15; przed nim streaming/fields.ts)' },
        { path: 'src/engine/runners/cli-tools/contract.ts', lines: 410, note: '+ cliNotFoundMessage(descriptor)' }
      ],
      moves: [
        'CliArgumentValidation w candidate-contract.ts:94 i process-invoke.ts:888 → import z validate-args.ts',
        'normalizeCliArgumentValidation, formatArgumentConflicts (process-invoke.ts:892-918) → validate-args.ts',
        'contributesToResultText (collector.ts:519) + contributesToRunnerResult (parsed-line-recorder.ts:197) + contributesToStreamedText (invoke-cli-adapter.ts:208) → calls/result-text.ts',
        'firstString ×2 → streaming/parse/fields.ts',
        'cliNotFoundMessage ×2 → cli-tools/contract.ts (jeden tekst; właściciel wybiera brzmienie)'
      ],
      tests: 'validate-args testowany dziś przez adaptery; nowy validate-args.test.ts dla normalizacji i redakcji konfliktów (dziś to prywatne funkcje process-invoke, testowane tylko przez spawn).',
      importers: 9,
      references: [],
      steps: [ '1. Przenieś typ i dwie funkcje do validate-args.ts.', '2. Utwórz calls/result-text.ts i przepnij trzy pliki.', '3. Utwórz plik firstString i przepnij dwa parsery.', '4. Przenieś cliNotFoundMessage. npm run typecheck && npm run lint.' ],
      risks: 'Punkt (d) zmienia tekst widoczny dla użytkownika w jednej z dwóch ścieżek — to decyzja właściciela (reguła User-facing text). Reszta bez zmiany zachowania.'
    },
    {
      id: 'RF_ENG_12',
      kind: 'split',
      priority: 2,
      effort: 'L',
      risk: 'medium',
      title: 'Podzielić runners/cli-tools/process-invoke.ts (1037) na folder process-invoke/',
      why: 'Największy plik części. invokeProcessCli (173-804) to jedna funkcja na 631 linii z domknięciem execute (326-663, 337 linii) i ponad 20 zmiennymi stanu (let w 177-324). W jednym pliku są: zapis eventu protokołu (recordCliProtocolEvent 101-172), walidacja przed startem (177-263), bufor linii i stosowanie eventów (execute 59-116), mapowanie zamknięcia procesu i terminala na wynik (execute 213-332), klasyfikacja haltów i błędów (805-1037; main dołożył tu odmowę konta na stderr jako Seat down w f307dcb i błąd przed startem argv-prompt-too-large w afbb4ea). Klasyfikacja błędów jest czysta, ale prywatna, więc testuje się ją tylko przez spawn w process-invoke.integration.test.ts.',
      before: [ { path: 'src/engine/runners/cli-tools/process-invoke.ts', lines: 1037, note: 'invokeProcessCli + recordCliProtocolEvent + klasyfikacja błędów' } ],
      after: [
        { path: 'src/engine/runners/cli-tools/process-invoke/invoke.ts', lines: 420, note: 'invokeProcessCli, CLI_RAW_OUTPUT_MAX_BYTES, typy kontekstu; jedno życie procesu' },
        { path: 'src/engine/runners/cli-tools/process-invoke/prelaunch.ts', lines: 110, note: 'poświadczenia, rekorder, walidacja argumentów przed startem → wynik albo porażka' },
        { path: 'src/engine/runners/cli-tools/process-invoke/stream.ts', lines: 90, note: 'bufor linii, parse, applyProtocolEvent, echo wejścia' },
        { path: 'src/engine/runners/cli-tools/process-invoke/terminal.ts', lines: 170, note: 'zamknięcie procesu + event terminala → RunnerCallResult (isFailureExit, halty stderr, odmowa)' },
        { path: 'src/engine/runners/cli-tools/process-invoke/protocol-event.ts', lines: 90, note: 'recordCliProtocolEvent' },
        { path: 'src/engine/runners/cli-tools/process-invoke/failures.ts', lines: 175, note: 'HALT_FAILURES, haltFailure, namesHalt, callbackFailure, finishFailureSafely, fail, fatal, fatalSignal, fatalStateOf, prelaunchErrorCode, errorMessage, prelaunchErrorMessage' }
      ],
      moves: [
        'recordCliProtocolEvent (101-172) → protocol-event.ts',
        'HALT_FAILURES, haltFailure, HALT_CODES, namesHalt, callbackFailure, finishFailureSafely (805-898) i fail, isFailureExit, fatal, fatalSignal, fatalStateOf, prelaunchErrorCode, errorMessage, prelaunchErrorMessage (944-1037) → failures.ts',
        'normalizeCliArgumentValidation, formatArgumentConflicts (900-930) → validate-args.ts (RF_ENG_11); selectedCredentialValues (931) → sandbox-credential-values.ts (RF_ENG_09)',
        'kod 177-263 invokeProcessCli → prelaunch.ts jako preparePrelaunch(context) zwracające { recorder, credentialValues, args } albo wynik porażki',
        'execute 59-116 (applyProtocolEvent, lineBuffer, allowInputEcho) → stream.ts jako createProtocolStream(state)',
        'execute 213-332 (sygnał, brak terminala, wynik terminala, halty) → terminal.ts jako resolveTerminalResult(closed, stan)'
      ],
      tests: 'process-invoke.integration.test.ts → process-invoke/invoke.integration.test.ts (zostaje test kompozycji). Nowe czyste testy: failures.test.ts (klasyfikacja haltów i błędów z samych danych), terminal.test.ts (zamknięcie + terminal → wynik bez spawnu), protocol-event.test.ts. vi.mock w invocation-identity-routing.test.ts:54-55 zmienia ścieżkę.',
      importers: 13,
      references: [ 'docs/PLANNERS-AND-IMPLEMENTERS.md:440', 'docs/PLANNERS-AND-IMPLEMENTERS.md:446', 'docs/APPROVAL-AND-RECOVERY.md:189', 'src/engine/runners/invocation-identity-routing.test.ts:54 (vi.mock)' ],
      steps: [ '1. Najpierw RF_ENG_09 i RF_ENG_11.', '2. Przenieś czyste funkcje (failures.ts, protocol-event.ts) bez zmian ciał.', '3. Zamień zmienne let domknięcia na jeden obiekt stanu przekazywany do stream.ts i terminal.ts.', '4. Wydziel prelaunch.ts.', '5. git mv do process-invoke/invoke.ts; zmień 13 importerów.', '6. npm run typecheck && npm run lint; potem process-invoke.integration.test.ts i testy adapterów.' ],
      risks: 'Średnie: domknięcie dzieli stan między timerem, kontrolerami abort i parserem; przeniesienie do obiektu stanu może zmienić kolejność sprzątania (finally 790-796). Łapie to process-invoke.integration.test.ts (1800+ linii scenariuszy). Bez zmiany zachowania z punktu widzenia użytkownika.'
    },
    {
      id: 'RF_ENG_13',
      kind: 'split',
      priority: 2,
      effort: 'L',
      risk: 'medium',
      title: 'Podzielić implementers/pipeline/run.ts (861)',
      why: 'createImplementerBase (178-861) to jedna fabryka na 680 linii z wewnętrznymi funkcjami: przygotowanie i zastosowanie paczki plików (bundleFailure 232, prepareCall 253, applyBundleOutput 302 — razem 155 linii), odczyt checkoutu i wykrycie ucieczki zapisu (readCheckout 389, checkoutEscape 423, warnChangedBetweenCalls 464 — 100 linii, plus moduł lastInPlaceByRun:80), i runCall (515-819, 300 linii), w którym druga połowa (661-819) mapuje wynik wywołania na ImplementerResult. Każda część zależy od baseConfig tylko przez kilka pól.',
      before: [ { path: 'src/engine/implementers/pipeline/run.ts', lines: 861, note: 'createImplementerBase' } ],
      after: [
        { path: 'src/engine/implementers/pipeline/run.ts', lines: 380, note: 'createImplementerBase: implement, retry, runPipeline, runCall do wywołania' },
        { path: 'src/engine/implementers/pipeline/bundle-io.ts', lines: 220, note: 'refreshTaskCode, aggregateApplied, bundleFailure, prepareCall, applyBundleOutput' },
        { path: 'src/engine/implementers/pipeline/checkout-guard.ts', lines: 130, note: 'CheckoutRead, lastInPlaceByRun, worksInPlace, readCheckout, checkoutEscape, warnChangedBetweenCalls' },
        { path: 'src/engine/implementers/pipeline/call-outcome.ts', lines: 170, note: 'mapowanie RunnerCallResult → ImplementerResult (ucieczka, status, raport blocked, parseImplementerReport)' }
      ],
      moves: [ 'refreshTaskCode, aggregateApplied, bundleFailure, prepareCall, applyBundleOutput → bundle-io.ts (parametry: baseConfig.writes, createdByTask)', 'lastInPlaceByRun, worksInPlace, readCheckout, checkoutEscape, warnChangedBetweenCalls → checkout-guard.ts', 'runCall 661-819 + parseImplementerReport → call-outcome.ts', 'retryTemperature, MAX_RETRY_TEMPERATURE zostają w run.ts' ],
      tests: 'run.integration.test.ts i run-events.integration.test.ts zostają. Nowe: checkout-guard.test.ts (porównanie stanów checkoutu bez wywołania modelu), call-outcome.test.ts (mapowanie wyniku z samych danych).',
      importers: 18,
      references: [ 'docs/APPROVAL-AND-RECOVERY.md:175', 'docs/EXTENDING.md:82', 'docs/PLANNERS-AND-IMPLEMENTERS.md:322', 'docs/TROUBLESHOOTING.md:545' ],
      steps: [ '1. Po RF_ENG_08 (importy file-bundle/*).', '2. Wydziel checkout-guard.ts (lastInPlaceByRun zostaje stanem modułu — reguła zero klas pozwala).', '3. Wydziel bundle-io.ts z jawnymi parametrami zamiast domknięcia.', '4. Wydziel call-outcome.ts.', '5. npm run typecheck && npm run lint; potem testy implementers/ i orchestrator/task.' ],
      risks: 'Średnie: lastInPlaceByRun to mapa modułu współdzielona między wywołaniami; musi zostać jedna instancja. Ścieżka entry run.ts się nie zmienia, więc 18 importerów zostaje bez zmian.'
    },
    {
      id: 'RF_ENG_14',
      kind: 'folderize',
      priority: 2,
      effort: 'M',
      risk: 'low',
      title: 'Sondy CLI do runners/cli-tools/probe/ i podział registry.ts (649)',
      why: 'registry.ts łączy pięć rzeczy: parsowanie wersji (52-183), parsowanie auth (184-340), zamrażanie zadeklarowanych sond (341-418), sondę katalogu (419-535) i składanie rejestru adapterów (536-649). Sondy są rozrzucone: cli-probe-evidence.ts, cli-probe-process.ts (prefiks cli-probe), readiness-probe.ts, provider-oracle.ts, a parsery natywnych katalogów CLI leżą w providers/cli-model-catalog.ts (importują je tylko registry.ts i detection/catalog-probe.ts).',
      before: [
        { path: 'src/engine/runners/cli-tools/registry.ts', lines: 649, note: 'wersja, auth, freeze, katalog, rejestr' },
        { path: 'src/engine/runners/cli-tools/cli-probe-evidence.ts', lines: 158, note: '' },
        { path: 'src/engine/runners/cli-tools/cli-probe-process.ts', lines: 270, note: '' },
        { path: 'src/engine/runners/cli-tools/readiness-probe.ts', lines: 362, note: '' },
        { path: 'src/engine/runners/cli-tools/provider-oracle.ts', lines: 188, note: '' },
        { path: 'src/engine/providers/cli-model-catalog.ts', lines: 501, note: 'parsery natywnych katalogów' }
      ],
      after: [
        { path: 'src/engine/runners/cli-tools/registry.ts', lines: 160, note: 'declaredProbe, withDeclared*Probe, assemble*, CLI_*_ADAPTERS, lookup*, isCanonicalCliDeclaredProbe' },
        { path: 'src/engine/runners/cli-tools/probe/version.ts', lines: 135, note: 'SEMVER/CALVER, versionOutputFormat, parseCalverVersion, parseVersion' },
        { path: 'src/engine/runners/cli-tools/probe/auth.ts', lines: 160, note: 'jsonAuthFact, looksOfflineDiagnostic, authFactFromText, parseStatusAuth, parseCommandCodeStatusAuth, declaredAuthProbe' },
        { path: 'src/engine/runners/cli-tools/probe/declared.ts', lines: 90, note: 'frozenParser, frozenProbeCommand, frozenVersionProbe, frozenAuthProbe, frozenCatalogProbe, frozenDeclaredProbe, frozenProbeContract' },
        { path: 'src/engine/runners/cli-tools/probe/catalog.ts', lines: 120, note: 'catalogParse, structuralCatalogProbe, declaredCatalogProbe' },
        { path: 'src/engine/runners/cli-tools/probe/native-catalog.ts', lines: 501, note: 'dawny providers/cli-model-catalog.ts (tabela parserów — keep)' },
        { path: 'src/engine/runners/cli-tools/probe/evidence.ts', lines: 158, note: 'dawny cli-probe-evidence.ts' },
        { path: 'src/engine/runners/cli-tools/probe/process.ts', lines: 225, note: 'dawny cli-probe-process.ts' },
        { path: 'src/engine/runners/cli-tools/probe/readiness.ts', lines: 362, note: 'dawny readiness-probe.ts' },
        { path: 'src/engine/runners/cli-tools/probe/provider-oracle.ts', lines: 188, note: '' }
      ],
      moves: [ 'registry.ts 52-183 → probe/version.ts', 'registry.ts 184-340 → probe/auth.ts', 'registry.ts 341-418 → probe/declared.ts', 'registry.ts 419-535 → probe/catalog.ts', 'cli-probe-evidence.ts → probe/evidence.ts; cli-probe-process.ts → probe/process.ts; readiness-probe.ts → probe/readiness.ts; provider-oracle.ts → probe/provider-oracle.ts', 'providers/cli-model-catalog.ts → probe/native-catalog.ts' ],
      tests: 'registry.test.ts zostaje dla rejestru; przypadki wersji i auth → probe/version.test.ts i probe/auth.test.ts (dziś są testowane tylko przez cały rejestr). readiness-probe*.integration.test.ts → probe/readiness*.integration.test.ts, provider-oracle.test.ts → probe/, cli-model-catalog.test.ts → probe/native-catalog.test.ts.',
      importers: 29,
      references: [ 'scripts/invariants/gates.ts:228 (bramka 29 importuje registry.ts — ścieżka bez zmian)', 'docs/SUBSYSTEMS.md:89', 'docs/EXTENDING.md:259', 'docs/ARCHITECTURE.md:659', 'src/features/runners/picker-view.tsx (import provider-oracle)', 'testing/helpers/factories/cursor-models.ts, testing/visual/fixtures/overlay-fixtures.ts, testing/visual/fixtures/screen-fixtures.ts (import cli-model-catalog)' ],
      steps: [ '1. Po RF_ENG_02 (probe/safety.ts już jest).', '2. Wytnij cztery bloki z registry.ts do probe/*.', '3. git mv pięciu plików sond i cli-model-catalog.ts razem z testami.', '4. Zmień importy: 29 plików importuje registry.ts, sondy albo cli-model-catalog.ts (11 prod); importerzy samego registry.ts zostają bez zmian.', '5. npm run typecheck && npm run lint && npm run check:invariants && npm run skills:check (skill-blocks.ts importuje registry.ts).' ],
      risks: 'Niskie. Ścieżka registry.ts zostaje, więc bramka 29 i scripts/skill-blocks.ts:37 bez zmian. Importer w src/features/runners/picker-view.tsx to inna część (zmiana jednej linii). cli-model-catalog to CLI, nie dostawca API, więc przenosiny poprawiają miejsce, nie warstwę.'
    },
    {
      id: 'RF_ENG_15',
      kind: 'folderize',
      priority: 2,
      effort: 'M',
      risk: 'low',
      title: 'Parsery strumienia streaming/parse-*.ts → streaming/parse/ i podział parse-stream-json.ts (635)',
      why: 'streaming/ ma 18 plików, 6 z prefiksem parse- plus output-parsers.ts i parser-warnings.ts. parse-stream-json.ts (635) łączy parser Claude stream-json (63-296, 492-635) z ramkami systemowymi i limitami (297-491: apiRetryWarning, modelFallbackWarning, modelRefusalWarning, permissionDeniedWarning, noticeWarning, systemFrameWarning, parseSystemProgress, parseRateLimitEvent — około 195 linii; od a9f2ab9 parseRateLimitEvent sam buduje ostrzeżenia progów 70–95 % z core/recovery/usage-limit-step.ts, a rateLimitWarning i rateLimitResetLabel zniknęły).',
      before: [
        { path: 'src/engine/streaming/parse-stream-json.ts', lines: 635, note: 'parser + ramki systemowe' },
        { path: 'src/engine/streaming/parse-jsonl.ts', lines: 208, note: '' },
        { path: 'src/engine/streaming/parse-opencode.ts', lines: 202, note: '' },
        { path: 'src/engine/streaming/parse-antigravity.ts', lines: 166, note: '' },
        { path: 'src/engine/streaming/parse-copilot.ts', lines: 118, note: '' },
        { path: 'src/engine/streaming/parse-text.ts', lines: 16, note: '' },
        { path: 'src/engine/streaming/output-parsers.ts', lines: 46, note: 'getLineParser' },
        { path: 'src/engine/streaming/parser-warnings.ts', lines: 90, note: '' }
      ],
      after: [
        { path: 'src/engine/streaming/parse/stream-json.ts', lines: 430, note: 'createStreamParser, parseStreamLine, schematy, narzędzia' },
        { path: 'src/engine/streaming/parse/system-frames.ts', lines: 195, note: 'ostrzeżenia ramek system i rate_limit_event (progi usage z core/recovery/usage-limit-step.ts)' },
        { path: 'src/engine/streaming/parse/jsonl.ts', lines: 200, note: '' },
        { path: 'src/engine/streaming/parse/opencode.ts', lines: 202, note: '' },
        { path: 'src/engine/streaming/parse/antigravity.ts', lines: 166, note: '' },
        { path: 'src/engine/streaming/parse/copilot.ts', lines: 118, note: '' },
        { path: 'src/engine/streaming/parse/text.ts', lines: 16, note: '' },
        { path: 'src/engine/streaming/parse/select.ts', lines: 46, note: 'dawny output-parsers.ts (getLineParser)' },
        { path: 'src/engine/streaming/parse/warnings.ts', lines: 90, note: 'dawny parser-warnings.ts' },
        { path: 'src/engine/streaming/parse/fields.ts', lines: 10, note: 'firstString (RF_ENG_11)' }
      ],
      moves: [ 'parse-stream-json.ts 297-491 → parse/system-frames.ts', 'parse-<x>.ts → parse/<x>.ts (6 plików)', 'output-parsers.ts → parse/select.ts', 'parser-warnings.ts → parse/warnings.ts' ],
      tests: 'parse-*.test.ts (6) → parse/*.test.ts, output-parsers.test.ts → parse/select.test.ts. Nowy parse/system-frames.test.ts testuje ostrzeżenia z pojedynczej ramki; dziś wymaga to całego parsera. parsed-line-recorder.ts zostaje w streaming/ (to rekorder, nie parser).',
      importers: 12,
      references: [ 'docs/PLANNERS-AND-IMPLEMENTERS.md:450', 'docs/PLANNERS-AND-IMPLEMENTERS.md:655', 'docs/PLANNERS-AND-IMPLEMENTERS.md:656', 'docs/PLANNERS-AND-IMPLEMENTERS.md:657', 'docs/PLANNERS-AND-IMPLEMENTERS.md:660', 'docs/PLANNERS-AND-IMPLEMENTERS.md:662', 'docs/PLANNERS-AND-IMPLEMENTERS.md:668', 'docs/PLANNERS-AND-IMPLEMENTERS.md:681', 'docs/ARCHITECTURE.md:707' ],
      steps: [ '1. git mv ośmiu plików i siedmiu testów do streaming/parse/.', '2. Wytnij system-frames.ts z stream-json.ts.', '3. Zmień importy (9 prod: cli-tools/claude-code.ts, claude-reply-parser.ts, kilo-code.ts, opencode.ts, copilot.ts, antigravity.ts, output-format.ts, planners/claude-invoke.ts, spawn-collect.ts).', '4. Popraw tabelę parserów w docs/PLANNERS-AND-IMPLEMENTERS.md:655-662. npm run typecheck && npm run lint.' ],
      risks: 'Niskie. Nazwa parse/ nie koliduje z engine/parsers/ (parsery odpowiedzi modelu), ale konwencja musi to rozróżniać: streaming/parse = protokół linii narzędzia, engine/parsers = treść odpowiedzi.'
    },
    {
      id: 'RF_ENG_16',
      kind: 'split',
      priority: 2,
      effort: 'M',
      risk: 'low',
      title: 'Podzielić providers/model/catalog.ts (790)',
      why: 'resolveModelCatalog składa katalog modeli z czterech źródeł, a plik trzyma każdą z reguł: scalanie metadanych (114-252), podpowiedzi z models.dev i z paczki (253-342, 448-471), wpisy opcji Claude Code (343-447), indeks kanoniczny i aliasy (509-577), nazwy z katalogu (696-761). 16 importerów (6 prod). Każda reguła jest czysta i dziś testowana tylko przez całe resolveModelCatalog w catalog.test.ts.',
      before: [ { path: 'src/engine/providers/model/catalog.ts', lines: 790, note: 'resolveModelCatalog + 35 funkcji pomocniczych' } ],
      after: [
        { path: 'src/engine/providers/model/catalog.ts', lines: 290, note: 'typy, ownerFor, isChatCapable, entryKey, runtimeModels, configuredSelectionId, hasExactSelection, resolveCatalogEntries, resolveModelCatalog' },
        { path: 'src/engine/providers/model/entry-metadata.ts', lines: 145, note: 'exactModelsDevMetadata, metadataForSelection, metadataForBundledModel, mergeRuntimeMetadata, stripUnpricedFields, runtimeEntry' },
        { path: 'src/engine/providers/model/suggestions.ts', lines: 120, note: 'modelsDevSuggestion, bundledSuggestion, lifecycleRank, compareSuggestions' },
        { path: 'src/engine/providers/model/claude-code-options.ts', lines: 110, note: 'versionedOptionLabel, peelDescriptionNameRepeat, claudeCodeOptionEntry, configuredRecovery' },
        { path: 'src/engine/providers/model/canonical-index.ts', lines: 75, note: 'identityOf, indexCanonically, indexNamesSameModel, aliasAnsweringToOptionId, withAliasDetail' },
        { path: 'src/engine/providers/model/names.ts', lines: 70, note: 'withToolEffortFloor, agreedCatalogName, catalogDisplayName, withCatalogNames' }
      ],
      moves: [ '114-252 → entry-metadata.ts', '253-342 + 448-471 → suggestions.ts', '343-447 → claude-code-options.ts', '509-577 → canonical-index.ts', '696-761 → names.ts' ],
      tests: 'catalog.test.ts zostaje dla resolveModelCatalog. Nowe testy jednostkowe: suggestions.test.ts (sortowanie po cyklu życia), canonical-index.test.ts (aliasy), claude-code-options.test.ts (etykiety wersji).',
      importers: 15,
      references: [ 'docs/PLANNERS-AND-IMPLEMENTERS.md:418', 'docs/SUBSYSTEMS.md:85' ],
      steps: [ '1. Wytnij pięć bloków do nowych plików w model/.', '2. catalog.ts importuje je; eksporty publiczne bez zmian.', '3. npm run typecheck && npm run lint; potem catalog.test.ts.' ],
      risks: 'Niskie: ścieżka entry bez zmian, 15 importerów bez zmian. Uwaga na stan modułu: brak (wszystko czyste).'
    },
    {
      id: 'RF_ENG_17',
      kind: 'split',
      priority: 2,
      effort: 'M',
      risk: 'low',
      title: 'Podzielić runners/arg-vector-preflight.ts (731) na runners/arg-vector/',
      why: 'Plik łączy pięć odpowiedzialności: rodziny flag i porównanie wektora (23-150), semantyczne flagi uprawnień (151-240), czytanie tekstu --help (241-298, 686-731), uruchamianie --help (583-685) i składanie checków gotowości (299-582). Parsowanie --help jest czyste, a dziś testuje się je tylko przez collectArgVectorPreflightChecks. 4 importery prod, 0 testów spoza pliku.',
      before: [ { path: 'src/engine/runners/arg-vector-preflight.ts', lines: 731, note: '' } ],
      after: [
        { path: 'src/engine/runners/arg-vector/preflight.ts', lines: 290, note: 'ArgVectorPreflightOutcome, collectArgVectorPreflightChecks, buildPreflightCheck, checkedVector, emittedArgVectors, plannerCommonArgs, argVectorCheckId, semanticOverrideCheck' },
        { path: 'src/engine/runners/arg-vector/flags.ts', lines: 130, note: 'FLAG_FAMILIES, checkRunnerArgVector, compareFlagFamily, emittedFlags, normalizeFlag' },
        { path: 'src/engine/runners/arg-vector/authority.ts', lines: 90, note: 'AUTHORITY_LONG_ARGUMENT_STEMS, AUTHORITY_SHORT_ARGUMENTS, semanticConfiguredArgViolations' },
        { path: 'src/engine/runners/arg-vector/help-text.ts', lines: 110, note: 'advertisedFlags, optionEntryLines, deprecatedFlags, declaresFlag, entryIsDeprecated, opensNewEntry, subcommandCandidate, commandNames' },
        { path: 'src/engine/runners/arg-vector/help-command.ts', lines: 105, note: 'resolveHelpInvocation, defaultRunHelp, fetchHelp, runHelpCommand' }
      ],
      moves: [ '23-150 → flags.ts', '151-240 → authority.ts', '241-298 + 686-731 → help-text.ts', '583-685 → help-command.ts', 'reszta → preflight.ts' ],
      tests: 'arg-vector-preflight.test.ts → arg-vector/preflight.test.ts. Nowy help-text.test.ts na stałych tekstach --help (bez procesu) i authority.test.ts.',
      importers: 4,
      references: [ 'docs/PLANNERS-AND-IMPLEMENTERS.md:255', 'docs/PLANNERS-AND-IMPLEMENTERS.md:547', 'docs/TROUBLESHOOTING.md:608' ],
      steps: [ '1. Utwórz runners/arg-vector/ i wytnij bloki.', '2. Zmień 4 importery.', '3. Popraw docs. npm run typecheck && npm run lint; potem test preflight.' ],
      risks: 'Niskie. Mały zasięg.'
    },
    {
      id: 'RF_ENG_18',
      kind: 'split',
      priority: 2,
      effort: 'M',
      risk: 'low',
      title: 'Podzielić detection/runner-evidence.ts (714)',
      why: 'Plik trzyma trzy rzeczy, których używają inne moduły, obok własnej logiki: klucz kontekstu runnerDiscoveryContextKey (85-122; importują go deps.ts, provider-outcomes.ts, prepare-execution/evaluate-candidate.ts), współdzielenie sond w locie createInFlightProbeSharing (123-202; importuje go runners/probe-availability.ts) i fakty dowodu z legacy readiness (273-422). probe-availability.ts importuje plik dowodów tylko dla mechanizmu współdzielenia.',
      before: [ { path: 'src/engine/detection/runner-evidence.ts', lines: 714, note: '' } ],
      after: [
        { path: 'src/engine/detection/runner-evidence.ts', lines: 380, note: 'DetectRunnerEvidenceOptions, nonCliRunnerEvidence, unresolvedCliEvidence, probeFailureEvidence, unsupportedCatalogEvidence, probeResolvedCliEvidence, detectRunnerEvidence' },
        { path: 'src/engine/detection/context-key.ts', lines: 45, note: 'runnerDiscoveryContextKey' },
        { path: 'src/engine/detection/in-flight-probes.ts', lines: 85, note: 'InFlightProbeSharing, awaitSharedProbe, createInFlightProbeSharing' },
        { path: 'src/engine/detection/evidence-facts.ts', lines: 160, note: 'executableFactFromResolved, compatibilityFromVersion, credentialFromCliAuth, modelRunFromCatalog, legacyAuthFact, compatibilityFromLegacy, executableFactFromLegacyReadiness, evidenceFromLegacyReadiness' }
      ],
      moves: [ '85-122 → context-key.ts', '123-202 → in-flight-probes.ts', '273-422 → evidence-facts.ts' ],
      tests: 'runner-evidence.test.ts zostaje. Nowe: in-flight-probes.test.ts (współdzielenie i anulowanie bez sondy), evidence-facts.test.ts (mapowanie faktów).',
      importers: 24,
      references: [ 'docs/BOOTSTRAP.md:71' ],
      steps: [ '1. Wytnij trzy bloki.', '2. Przepnij deps.ts, provider-outcomes.ts, evaluate-candidate.ts, probe-availability.ts na nowe pliki.', '3. npm run typecheck && npm run lint.' ],
      risks: 'Niskie. cliEvidenceProbes (203) zostaje instancją modułu w runner-evidence.ts.'
    },
    {
      id: 'RF_ENG_19',
      kind: 'split',
      priority: 2,
      effort: 'M',
      risk: 'low',
      title: 'Podzielić providers/cost/breakdown.ts (678)',
      why: 'Plik łączy metadane rozliczenia runu (48-306: resolveProviderRunMetadata, describeOfferingBillingPresentation, deskryptory API/CLI/custom, zbieranie dowodów billingu) z rachunkiem kosztu implementera (388-558) i z samym rozbiciem kosztu (307-387, 559-678). Ma też lokalną kopię isCliToolId (64) identyczną z core/runners/cli-tool-catalog.ts:816.',
      before: [ { path: 'src/engine/providers/cost/breakdown.ts', lines: 678, note: '' } ],
      after: [
        { path: 'src/engine/providers/cost/breakdown.ts', lines: 240, note: 'CostBreakdownOptions, calculateRecordedCostBreakdown, calculateCostBreakdown' },
        { path: 'src/engine/providers/cost/run-metadata.ts', lines: 265, note: 'resolveProviderRunMetadata, describeOfferingBillingPresentation, apiDescriptorMetadata, cliDescriptorMetadata, customEndpointMetadata, collectRunMetadataTools, collectBillingEvidence, buildProviderRunMetadataRecord' },
        { path: 'src/engine/providers/cost/implementer-cost.ts', lines: 175, note: 'applyImplementerUsageSegment, applyImplementerUsageCost, calculateAggregateImplementerCost, calculateTaskAwareImplementerCost' }
      ],
      moves: [ '48-306 → run-metadata.ts', '388-558 → implementer-cost.ts', 'isCliToolId (64) → import z core/runners/cli-tool-catalog.ts' ],
      tests: 'breakdown.test.ts zostaje; przypadki metadanych → run-metadata.test.ts.',
      importers: 7,
      references: [ 'docs/EXTENDING.md:110', 'docs/TESTING.md:478' ],
      steps: [ '1. Wytnij dwa bloki.', '2. Zmień import resolveProviderRunMetadata i describeOfferingBillingPresentation w: providers/client/metadata.test.ts, cost/breakdown.test.ts, testing/visual/fixtures/workflow/at-rest-projections.ts.', '3. npm run typecheck && npm run lint.' ],
      risks: 'Niskie.'
    },
    {
      id: 'RF_ENG_20',
      kind: 'folderize',
      priority: 2,
      effort: 'M',
      risk: 'low',
      title: 'Runner własny (custom) → runners/custom/',
      why: 'runners/ ma 35 plików. Osiem dotyczy jednego tematu, runnera własnego (shell/agent): configured-custom.ts, consent-preflight.ts, custom-admission.ts, custom-launchability.ts, custom-runner-disclosure.ts, custom-runner-runtime.ts, custom-trust.ts, redaction.ts (eksporty customRunner*). Prefiks custom- i custom-runner- się mieszają.',
      before: [
        { path: 'src/engine/runners/custom-trust.ts', lines: 356, note: '' },
        { path: 'src/engine/runners/custom-admission.ts', lines: 328, note: '' },
        { path: 'src/engine/runners/custom-launchability.ts', lines: 312, note: '' },
        { path: 'src/engine/runners/redaction.ts', lines: 407, note: 'customRunnerEnvironmentError, CustomRunnerRedactor' },
        { path: 'src/engine/runners/consent-preflight.ts', lines: 187, note: '' },
        { path: 'src/engine/runners/custom-runner-disclosure.ts', lines: 90, note: '' },
        { path: 'src/engine/runners/custom-runner-runtime.ts', lines: 80, note: '' },
        { path: 'src/engine/runners/configured-custom.ts', lines: 13, note: '' }
      ],
      after: [
        { path: 'src/engine/runners/custom/trust.ts', lines: 356, note: '' },
        { path: 'src/engine/runners/custom/admission.ts', lines: 328, note: '' },
        { path: 'src/engine/runners/custom/launchability.ts', lines: 312, note: '' },
        { path: 'src/engine/runners/custom/redaction.ts', lines: 407, note: '' },
        { path: 'src/engine/runners/custom/consent-preflight.ts', lines: 187, note: '' },
        { path: 'src/engine/runners/custom/disclosure.ts', lines: 90, note: '' },
        { path: 'src/engine/runners/custom/runtime.ts', lines: 80, note: '' },
        { path: 'src/engine/runners/custom/configured.ts', lines: 13, note: '' }
      ],
      moves: [ 'custom-trust.ts → custom/trust.ts', 'custom-admission.ts → custom/admission.ts', 'custom-launchability.ts → custom/launchability.ts', 'redaction.ts → custom/redaction.ts', 'consent-preflight.ts → custom/consent-preflight.ts', 'custom-runner-disclosure.ts → custom/disclosure.ts', 'custom-runner-runtime.ts → custom/runtime.ts', 'configured-custom.ts → custom/configured.ts' ],
      tests: 'Przenoszą się: configured-custom.test.ts, consent-preflight.test.ts, custom-admission.test.ts, custom-admission-disclosure.test.ts, custom-runner-disclosure.test.ts, custom-runner-runtime.integration.test.ts, custom-trust.test.ts, redaction.test.ts. custom-launchability.ts nie ma własnego testu (testowany przez custom-admission.test.ts).',
      importers: 42,
      references: [ 'docs/ARCHITECTURE.md:669 (drzewo runners/)' ],
      steps: [ '1. git mv ośmiu plików i ośmiu testów.', '2. Zmień 42 importery. Prod (15): src/cli/commands/doctor.ts, review.ts, spec.ts, implementers/command-invoke.ts, planners/command-invoke.ts, orchestrator/run/init.ts, runners/command-based.ts, factory.ts, factory-gates.ts, prepared-execution.ts, prepare-execution/{abort-guard,evaluate-candidate,prepare-execution,types}.ts, streaming/spawn-collect.ts. Poza src: testing/helpers/{configured-custom-implementer,custom-command-based,planner-command-invoke,runner-trust}.ts, testing/visual/fixtures/screen-fixtures.ts.', '3. npm run typecheck && npm run lint && npm run check:invariants.' ],
      risks: 'Niskie, ale szeroki zasięg (42 pliki, 5 spoza src). Bez zmiany zachowania; łapie to typecheck.'
    },
    {
      id: 'RF_ENG_21',
      kind: 'folderize',
      priority: 2,
      effort: 'M',
      risk: 'low',
      title: 'Piaskownica runnera sandbox-*.ts → runners/sandbox/',
      why: 'Cztery pliki z prefiksem sandbox- (credential-values 53, env 378, state-bridge 467, state-paths 339; razem 1237 linii) opisują jedno: środowisko HOME/XDG runnera i przenoszenie stanu logowania. Leżą płasko między 31 innymi plikami runners/.',
      before: [
        { path: 'src/engine/runners/sandbox-env.ts', lines: 378, note: '' },
        { path: 'src/engine/runners/sandbox-state-bridge.ts', lines: 467, note: '' },
        { path: 'src/engine/runners/sandbox-state-paths.ts', lines: 339, note: '' },
        { path: 'src/engine/runners/sandbox-credential-values.ts', lines: 53, note: '' }
      ],
      after: [
        { path: 'src/engine/runners/sandbox/env.ts', lines: 370, note: 'po RF_ENG_09' },
        { path: 'src/engine/runners/sandbox/state-bridge.ts', lines: 467, note: '' },
        { path: 'src/engine/runners/sandbox/state-paths.ts', lines: 339, note: '' },
        { path: 'src/engine/runners/sandbox/credential-values.ts', lines: 90, note: 'po RF_ENG_09' }
      ],
      moves: [ 'sandbox-env.ts → sandbox/env.ts', 'sandbox-state-bridge.ts → sandbox/state-bridge.ts', 'sandbox-state-paths.ts → sandbox/state-paths.ts', 'sandbox-credential-values.ts → sandbox/credential-values.ts' ],
      tests: 'sandbox-env.test.ts → sandbox/env.test.ts, sandbox-auth-selection.test.ts → sandbox/auth-selection.test.ts. state-bridge nie ma własnego testu — warto dodać sandbox/state-bridge.test.ts (dziś kryty pośrednio).',
      importers: 32,
      references: [ 'docs/EXTENDING.md:256', 'docs/HOW-IT-WORKS.md:198', 'docs/API-KEYS.md:144', 'docs/API-KEYS.md:174', 'docs/PLANNERS-AND-IMPLEMENTERS.md:452', 'docs/ARCHITECTURE.md:675' ],
      steps: [ '1. Po RF_ENG_09.', '2. git mv czterech plików i dwóch testów.', '3. Zmień 32 importery (21 prod: detection, planners, implementers, cli-tools, streaming).', '4. Popraw docs. npm run typecheck && npm run lint.' ],
      risks: 'Niskie; szeroki zasięg. Łapie to typecheck.'
    },
    {
      id: 'RF_ENG_22',
      kind: 'split',
      priority: 2,
      effort: 'M',
      risk: 'medium',
      title: 'Podzielić runners/resolve-cli-executable.ts (579) na runners/cli-executable/',
      why: 'Plik łączy tożsamość i odcisk pliku wykonywalnego (100-320: fingerprintsEqual, digestExecutable, readExecutableIdentity, revalidateCliExecutableIdentity, assertTrustedIdentity), rozwiązywanie runnera własnego (320-414: resolveCustomExecutable) i rozwiązywanie z PATH (415-579: sanitizedRuntimePath, resolveCliExecutable, resolveCliExecutableAliases). Ma też kopię isWithin (104) z innym zapisem niż implementers/isolation/boundary.ts:159 i lib isInsideRoot.',
      before: [ { path: 'src/engine/runners/resolve-cli-executable.ts', lines: 579, note: '' } ],
      after: [
        { path: 'src/engine/runners/cli-executable/identity.ts', lines: 235, note: 'executableChangedMessage, fingerprintsEqual, receiptFromTrust, digestExecutable, readExecutableIdentity, exactTrustMatches, revalidateCliExecutableIdentity, assertTrustedIdentity' },
        { path: 'src/engine/runners/cli-executable/custom.ts', lines: 110, note: 'customExecutableNames, inspectCustomExecutableCandidate, resolveCustomExecutable' },
        { path: 'src/engine/runners/cli-executable/resolve.ts', lines: 230, note: 'typy, firstExecutable, sanitizedRuntimePath, resolveCliExecutable, resolveCliExecutableAliases' }
      ],
      moves: [ '73-319 → identity.ts', '320-414 → custom.ts', '415-579 + typy 21-72 → resolve.ts', 'isWithin (104) → lib isInsideRoot po ujednoliceniu (konwencja; dom w lib)' ],
      tests: 'resolve-cli-executable.test.ts dzieli się na identity.test.ts i resolve.test.ts.',
      importers: 52,
      references: [ 'docs/EXTENDING.md:251' ],
      steps: [ '1. Wytnij trzy pliki.', '2. Zmień 52 importery: każdy importuje to, czego używa (identity vs resolve).', '3. npm run typecheck && npm run lint.' ],
      risks: 'Średnie przez zasięg (52 pliki, 22 prod) i kod bezpieczeństwa (tożsamość pliku wykonywalnego). Zachowanie bez zmian. Łapie to typecheck i resolve-cli-executable.test.ts.'
    },
    {
      id: 'RF_ENG_23',
      kind: 'split',
      priority: 2,
      effort: 'M',
      risk: 'medium',
      title: 'Podzielić prepare-execution/ (evaluate-candidate 621, prepare-execution 528) i wciągnąć prepared-execution.ts',
      why: 'Trzy problemy w jednym miejscu. (1) runners/prepared-execution.ts (143, typy) leży obok folderu runners/prepare-execution/ — plik obok folderu. (2) prepare-execution/prepare-execution.ts powtarza nazwę folderu. (3) evaluate-candidate.ts łączy problem przyjęcia CLI (cliAdmissionProblem 72-228), ocenę CLI (evaluateCli 229-410), ocenę API (411-452) i ocenę komendy z odmową runnera inline (453-605). prepare-execution.ts łączy przyjęcie runnerów (admitRunners 222-348 z pomocnikami 110-190) z wejściami prepareExecution i collectRunnerAdmissionChecks.',
      before: [
        { path: 'src/engine/runners/prepare-execution/evaluate-candidate.ts', lines: 621, note: '' },
        { path: 'src/engine/runners/prepare-execution/prepare-execution.ts', lines: 528, note: '' },
        { path: 'src/engine/runners/prepared-execution.ts', lines: 143, note: 'RunnerSlot, PreparedConfig, CommandGate, RunnerGate' }
      ],
      after: [
        { path: 'src/engine/runners/prepare-execution/evaluate-candidate.ts', lines: 90, note: 'evaluateApi, evaluateCandidate (dyspozycja)' },
        { path: 'src/engine/runners/prepare-execution/cli-admission.ts', lines: 165, note: 'UNVERIFIED_AUTH_FIX, cliAdmissionProblem' },
        { path: 'src/engine/runners/prepare-execution/evaluate-cli.ts', lines: 195, note: 'wait, evaluateCli' },
        { path: 'src/engine/runners/prepare-execution/evaluate-command.ts', lines: 160, note: 'INLINE_RUNNER_GRANT_FIX, REPO_LOCAL_RUNNER_REFUSAL, REPO_LOCAL_RUNNER_FIX, inlineRunnerRefusal, evaluateCommand' },
        { path: 'src/engine/runners/prepare-execution/admission.ts', lines: 245, note: 'revalidateCliGates, withEffectiveModels, calledRoles, exemptReadOnlyBlockers, admitRunners' },
        { path: 'src/engine/runners/prepare-execution/prepare.ts', lines: 290, note: 'dawny prepare-execution.ts bez admission' },
        { path: 'src/engine/runners/prepare-execution/prepared.ts', lines: 143, note: 'dawny runners/prepared-execution.ts' }
      ],
      moves: [ 'evaluate-candidate.ts 53-228 → cli-admission.ts; 229-410 → evaluate-cli.ts; 453-605 → evaluate-command.ts', 'prepare-execution.ts 110-348 → admission.ts', 'prepare-execution/prepare-execution.ts → prepare-execution/prepare.ts', 'runners/prepared-execution.ts → prepare-execution/prepared.ts' ],
      tests: 'evaluate-candidate.test.ts dzieli się na cli-admission.test.ts i evaluate-command.test.ts; prepare-execution.test.ts → prepare.test.ts; prepared-execution.test.ts → prepared.test.ts.',
      importers: 107,
      references: [ 'docs/LAYERS.md:191', 'docs/PLANNERS-AND-IMPLEMENTERS.md:23', 'docs/EXTENDING.md:105' ],
      steps: [ '1. Najpierw podziały wewnątrz folderu (evaluate-candidate, admission) — zasięg 3 importery.', '2. Potem rename prepare.ts (40 importerów) i przeniesienie prepared.ts (86 importerów) w osobnym kroku.', '3. Popraw docs/LAYERS.md:191 (stores importują typy z prepared-execution.ts). npm run typecheck && npm run lint && npm run check:invariants (gate 19: stores → engine tylko type-only).' ],
      risks: 'Średnie przez zasięg: 107 plików (31 prod, 62 testy, 14 innych) i importy type-only ze stores. Krok 1 można zrobić bez kroku 2. Łapie to typecheck i dependency-cruiser.'
    },
    {
      id: 'RF_ENG_24',
      kind: 'split',
      priority: 2,
      effort: 'M',
      risk: 'low',
      title: 'Adapter Claude Code jako folder runners/cli-tools/claude-code/',
      why: 'cli-tools/claude-code.ts (559) łączy pięć części: budowę argv i ustawień piaskownicy (87-209), mapowanie stream-json na eventy protokołu (210-315), transport sterowania CLAUDE_STEERING i inputLine (316-425), sondę i fabrykę adaptera (426-492), surowy kontrakt conformance CLI_CONFORMANCE_CANDIDATES (494-559). Obok leży claude-reply-parser.ts (114), którego używa tylko claude-code.ts.',
      before: [
        { path: 'src/engine/runners/cli-tools/claude-code.ts', lines: 559, note: '' },
        { path: 'src/engine/runners/cli-tools/claude-reply-parser.ts', lines: 114, note: 'createClaudeReplyParser' }
      ],
      after: [
        { path: 'src/engine/runners/cli-tools/claude-code/adapter.ts', lines: 100, note: 'createProbe, createAdapter, claudeCodePlannerAdapter, claudeCodeImplementerAdapter' },
        { path: 'src/engine/runners/cli-tools/claude-code/args.ts', lines: 130, note: 'schemaArgs, buildBaseArgs, skillRootPermissions, plannerBaseArgs, sandboxSettings, blocksReadsOutside, linkedNodeModules, implementerBaseArgs, validateArgs' },
        { path: 'src/engine/runners/cli-tools/claude-code/protocol.ts', lines: 115, note: 'createClaudeParser, toProtocolEvents, protocolEvents, claudeProtocolEvents' },
        { path: 'src/engine/runners/cli-tools/claude-code/steering.ts', lines: 115, note: 'CLAUDE_STEERING, inputLine' },
        { path: 'src/engine/runners/cli-tools/claude-code/conformance.ts', lines: 70, note: 'RawClaudeCliContract, rawContract, CLI_CONFORMANCE_CANDIDATES (moduł dla --module)' },
        { path: 'src/engine/runners/cli-tools/claude-code/reply-parser.ts', lines: 114, note: 'dawny claude-reply-parser.ts' }
      ],
      moves: [ '87-209 → args.ts', '210-315 + claudeProtocolEvents (557) → protocol.ts', '316-425 → steering.ts', '426-492 → adapter.ts', '494-556 → conformance.ts', 'claude-reply-parser.ts → claude-code/reply-parser.ts' ],
      tests: 'claude-code.test.ts (1000+ linii) dzieli się na args.test.ts, protocol.test.ts, conformance.test.ts. Import zmieniają: usage-limit.test.ts, typed-output-replay.test.ts, typed-output-seat-kinds.integration.test.ts, invoke-cli-adapter.test.ts, contract.test.ts, output-format.test.ts, process-invoke.integration.test.ts, testing/integration/ui/thinking-freshness.test.ts, testing/visual/fixtures/workflow/projections.ts.',
      importers: 13,
      references: [ 'docs/PLANNERS-AND-IMPLEMENTERS.md:450', 'docs/PLANNERS-AND-IMPLEMENTERS.md:515', 'docs/PLANNERS-AND-IMPLEMENTERS.md:685', 'docs/TROUBLESHOOTING.md:638', 'skills/splitbrief/references/tool-recipes.md:5', 'skills/splitbrief-run/references/tool-recipes.md:5', 'skills/splitbrief-review/references/tool-recipes.md:5' ],
      steps: [ '1. Utwórz folder i wytnij części.', '2. registry.ts, planners/claude-invoke.ts i runners/claude/args.ts importują claude-code/adapter.ts; existing-contract.test.ts importuje claude-code/conformance.ts.', '3. Skille: tekst src/engine/runners/cli-tools/*.ts → src/engine/runners/cli-tools/** (skills:sync, potem skills:check).', '4. npm run typecheck && npm run lint && npm run skills:check.' ],
      risks: 'Niskie. scripts/cli-conformance.ts production --module ładuje moduł z CLI_CONFORMANCE_CANDIDATES — kandydat niesie obiekt adaptera, więc osobny conformance.ts działa. Łapie to existing-contract.test.ts.'
    },
    {
      id: 'RF_ENG_25',
      kind: 'split',
      priority: 2,
      effort: 'M',
      risk: 'medium',
      title: 'Adapter Codex jako folder runners/cli-tools/codex/ + jedno czytanie elementu Codex',
      why: 'cli-tools/codex.ts (523) łączy argv (67-155), fabryki adapterów (156-216), parser rekordów JSONL (217-440) i kontrakt conformance (444-523). Ponadto Codex JSONL jest czytany dwa razy z rozjechaną logiką: streaming/parse-jsonl.ts (codexToolName, codexToolInput kopiuje 10 kluczy, codexToolOutput, parseCodexToolItem 67-119; dla runnerów z outputFormat jsonl) i codex.ts (codexToolEvent 288-319 kopiuje 3 klucze: command, cwd, changes; extractAgentText). Ten sam event narzędzia Codex daje dwa różne wejścia narzędzia zależnie od ścieżki.',
      before: [
        { path: 'src/engine/runners/cli-tools/codex.ts', lines: 523, note: '' },
        { path: 'src/engine/streaming/parse-jsonl.ts', lines: 208, note: 'drugi czytnik elementu Codex' }
      ],
      after: [
        { path: 'src/engine/runners/cli-tools/codex/adapter.ts', lines: 110, note: 'CODEX_NATIVE_MODEL_CATALOG_PROBE, createCodexPlannerAdapter, createCodexImplementerAdapter, codexPlannerAdapter, codexImplementerAdapter' },
        { path: 'src/engine/runners/cli-tools/codex/args.ts', lines: 95, note: 'validateArgs, schemaArgs, plannerBaseArgs, implementerBaseArgs' },
        { path: 'src/engine/runners/cli-tools/codex/protocol.ts', lines: 210, note: 'protocolFailure, codexEmbeddedErrorMessage, codexTurnFailedDetail, parseCodexRecord, codexProtocolEvents, codexTerminal' },
        { path: 'src/engine/runners/cli-tools/codex/conformance.ts', lines: 80, note: 'RawCodexCliContract, codexRawContract, CLI_CONFORMANCE_CANDIDATES' },
        { path: 'src/engine/streaming/parse/codex-item.ts', lines: 60, note: 'readCodexItem(item) → { name, id, input, output } i extractAgentText — wspólne dla obu czytników' }
      ],
      moves: [ '67-155 → args.ts', '156-216 + 28-62 → adapter.ts', '217-440 → protocol.ts', '444-523 → conformance.ts', 'codexToolName, codexToolInput, codexToolOutput (parse-jsonl.ts) + codexToolEvent, extractAgentText (codex.ts) → streaming/parse/codex-item.ts' ],
      tests: 'codex.integration.test.ts → codex/protocol.integration.test.ts i codex/conformance.test.ts; codex-images.test.ts → codex/args.test.ts. Nowy codex-item.test.ts pinuje jedno wejście narzędzia dla obu ścieżek.',
      importers: 12,
      references: [ 'docs/PLANNERS-AND-IMPLEMENTERS.md:452', 'docs/PLANNERS-AND-IMPLEMENTERS.md:658' ],
      steps: [ '1. Folder i wycięcie części bez zmiany zachowania.', '2. Osobny krok: wspólny codex-item.ts. Właściciel decyduje, który zbiór kluczy wejścia jest właściwy (10 czy 3).', '3. npm run typecheck && npm run lint; testy codex i parse-jsonl.' ],
      risks: 'Średnie dla kroku 2: ujednolicenie zmienia wejście narzędzia widoczne w transkrypcie dla jednej ścieżki (wiersze tool-use). Krok 1 jest bez ryzyka. Łapie to codex.integration.test.ts i parse-jsonl.test.ts.'
    },
    {
      id: 'RF_ENG_26',
      kind: 'merge',
      priority: 2,
      effort: 'S',
      risk: 'low',
      title: 'Planner Claude Code w jednym folderze planners/claude-code/ (wchłonąć runners/claude/)',
      why: 'Folder runners/claude/ ma dwa pliki produkcyjne (args.ts 53, child-env.ts 10), których używa tylko planners/claude-invoke.ts, oraz pięć testów (child-env.test.ts, invoke-error-redaction, one-shot, planner, reply .integration.test.ts), które testują ścieżkę plannera, a nie runners/. W planners/ leżą claude-code.ts (263) i claude-invoke.ts (159) — prefiks claude-. Kod jednego adaptera plannera jest w dwóch warstwach folderów.',
      before: [
        { path: 'src/engine/planners/claude-code.ts', lines: 263, note: 'createClaudeCodePlanner' },
        { path: 'src/engine/planners/claude-invoke.ts', lines: 159, note: 'invokeClaudePlanner' },
        { path: 'src/engine/runners/claude/args.ts', lines: 53, note: 'buildClaudeArgs' },
        { path: 'src/engine/runners/claude/child-env.ts', lines: 10, note: 'claudeCredentialValues' }
      ],
      after: [
        { path: 'src/engine/planners/claude-code/planner.ts', lines: 263, note: '' },
        { path: 'src/engine/planners/claude-code/invoke.ts', lines: 159, note: '' },
        { path: 'src/engine/planners/claude-code/args.ts', lines: 53, note: '' },
        { path: 'src/engine/planners/claude-code/child-env.ts', lines: 10, note: '' }
      ],
      moves: [ 'planners/claude-code.ts → planners/claude-code/planner.ts', 'planners/claude-invoke.ts → planners/claude-code/invoke.ts', 'runners/claude/args.ts → planners/claude-code/args.ts', 'runners/claude/child-env.ts → planners/claude-code/child-env.ts', 'usunąć pusty folder runners/claude/' ],
      tests: 'Pięć testów z runners/claude/ i planners/claude-code.integration.test.ts → planners/claude-code/. testing/helpers/claude-planner-steer-test-invoke.ts zmienia import.',
      importers: 9,
      references: [ 'docs/LAYERS.md:305', 'docs/ARCHITECTURE.md:204', 'docs/ARCHITECTURE.md:654', 'docs/ARCHITECTURE.md:673', 'docs/ARCHITECTURE.md:1053' ],
      steps: [ '1. git mv czterech plików i sześciu testów.', '2. runners/factory.ts importuje planners/claude-code/planner.ts.', '3. Popraw drzewo ports-and-adapters w docs/LAYERS.md:305. npm run typecheck && npm run lint.' ],
      risks: 'Niskie; 1 importer prod (runners/factory.ts).'
    },
    {
      id: 'RF_ENG_27',
      kind: 'split',
      priority: 2,
      effort: 'M',
      risk: 'low',
      title: 'Podzielić planners/api-context.ts (588) na planners/api-context/',
      why: 'buildApiPlanningContext (414-588) składa kontekst dla plannera API, a plik trzyma każdą regułę: wykrywanie ścieżek w prompcie (124-246: absolutePathsNamed, isCandidatePath, collectIntentPaths, collectMentions), odczyt i ogrodzenie źródeł (247-304: readSource, fenceFor, sourceBlock, rankedRepoMapPaths), budżet sekcji (305-413: section, notSuppliedLines, composeText, overflowingSections, wholeLinePrefix). Wykrywanie ścieżek jest czystą funkcją tekstu i warto ją testować osobno.',
      before: [ { path: 'src/engine/planners/api-context.ts', lines: 588, note: '' } ],
      after: [
        { path: 'src/engine/planners/api-context/build.ts', lines: 230, note: 'typy, apiPlanningInputBudget, buildApiPlanningContext' },
        { path: 'src/engine/planners/api-context/mentions.ts', lines: 135, note: 'absolutePathsNamed, isCandidatePath, describesExisting, normalizeCandidate, looksLikeExplicitPath, collectIntentPaths, record, collectMentions' },
        { path: 'src/engine/planners/api-context/sources.ts', lines: 65, note: 'readSource, fenceFor, sourceBlock, rankedRepoMapPaths' },
        { path: 'src/engine/planners/api-context/compose.ts', lines: 115, note: 'section, notSuppliedLines, composeText, overflowingSections, wholeLinePrefix' }
      ],
      moves: [ '124-246 → mentions.ts', '247-304 → sources.ts', '305-413 → compose.ts', 'reszta → build.ts' ],
      tests: 'api-context.test.ts → api-context/build.test.ts; nowy mentions.test.ts (ścieżki w tekście bez systemu plików).',
      importers: 3,
      references: [ 'docs/PLANNERS-AND-IMPLEMENTERS.md:139', 'docs/ARCHITECTURE.md:655' ],
      steps: [ '1. Wytnij trzy pliki.', '2. Zmień 3 importery.', '3. npm run typecheck && npm run lint.' ],
      risks: 'Niskie. fenceFor to jedna z czterech kopii ogrodzenia markdown (patrz conventions).'
    },
    {
      id: 'RF_ENG_28',
      kind: 'split',
      priority: 2,
      effort: 'M',
      risk: 'low',
      title: 'Podzielić detection/cache.ts (523) na folder detection/cache/ (schemat, kodek, magazyn)',
      why: 'Plik łączy schemat Zod cache detekcji (36-190), czyste przekształcenia snapshot ↔ rekord (244-397: restoreCliTool, cachedModels, cachedProvider, cachedCliCatalog, cachedCliTool, buildCache, snapshotFromCache) i I/O pliku (218, 398-523). Kodek jest czysty, ale testy (cache.test.ts i 17 innych) przechodzą przez dysk.',
      before: [ { path: 'src/engine/detection/cache.ts', lines: 523, note: '' } ],
      after: [
        { path: 'src/engine/detection/cache/store.ts', lines: 150, note: 'I/O: cachePath, readCacheRaw, readCache, load*, saveDetectionCache, invalidateCache' },
        { path: 'src/engine/detection/cache/schema.ts', lines: 160, note: 'hasSensitiveCacheValue, hasPrivateContextIdentifier, schematy, DetectionCache' },
        { path: 'src/engine/detection/cache/codec.ts', lines: 160, note: 'restoreCliTool, cachedModels, cachedProvider, cachedCliCatalog, cachedCliTool, buildCache, snapshotFromCache' }
      ],
      moves: [ '36-190 → cache/schema.ts', '244-397 → cache/codec.ts', 'reszta cache.ts → cache/store.ts' ],
      tests: 'cache.test.ts → cache/store.test.ts dla I/O; nowy cache/codec.test.ts (snapshot → rekord → snapshot bez dysku).',
      importers: 26,
      references: [ 'docs/SUBSYSTEMS.md:69' ],
      steps: [ '1. Utwórz detection/cache/ i wytnij trzy pliki.', '2. Zmień 26 importerów (8 prod) na cache/store.js.', '3. npm run typecheck && npm run lint.' ],
      risks: 'Niskie; 26 importerów zmienia ścieżkę (18 to testy). Pliki cache-schema.ts i cache-codec.ts obok cache.ts byłyby nową grupą prefiksu, dlatego folder.'
    },
    {
      id: 'RF_ENG_29',
      kind: 'split',
      priority: 2,
      effort: 'S',
      risk: 'low',
      title: 'Wydzielić błędy i emisję z providers/openai-stream/completion.ts (512)',
      why: 'streamCompletion (321-499) to jedna funkcja; reszta pliku to emisja eventów (100-223: emitText, emitToolUseDeltas, emitOpenAiTerminal) i redakcja oraz mapowanie błędów (247-320, 500-512: mapProviderError, redactStreamErrorData, throwRedactedAbort, finishOpenAiFailure, redactThrownError). redactThrownError ma tę samą nazwę i cel co streaming/spawn-collect.ts:409, ale inne ciało (inne kody błędów).',
      before: [ { path: 'src/engine/providers/openai-stream/completion.ts', lines: 512, note: '' } ],
      after: [
        { path: 'src/engine/providers/openai-stream/completion.ts', lines: 260, note: 'openAiCallContext, isPolicyFinishReason, resolveCompletionPolicy, streamCompletion' },
        { path: 'src/engine/providers/openai-stream/emit.ts', lines: 130, note: 'emitText, emitToolUseDeltas, emitOpenAiTerminal' },
        { path: 'src/engine/providers/openai-stream/errors.ts', lines: 100, note: 'mapProviderError, redactStreamErrorData, throwRedactedAbort, finishOpenAiFailure, redactThrownError' }
      ],
      moves: [ '100-223 → emit.ts', '247-320 + 500-512 → errors.ts' ],
      tests: 'completion.test.ts zostaje; nowy errors.test.ts (redakcja danych błędu bez strumienia).',
      importers: 6,
      references: [ 'scripts/invariants/gates.ts:249 (bramka 32 wymaga, by chat.completions.create było tylko w openai-stream/ — folder bez zmian)' ],
      steps: [ '1. Wytnij dwa pliki w tym samym folderze.', '2. npm run typecheck && npm run lint && npm run check:invariants.' ],
      risks: 'Niskie; bramka 32 sprawdza folder, a nie plik.'
    },
    {
      id: 'RF_ENG_30',
      kind: 'folderize',
      priority: 3,
      effort: 'M',
      risk: 'low',
      title: 'Wywołanie API api-*.ts → providers/api/',
      why: 'Cztery pliki z prefiksem api- (api-budget 372, api-deadlines 156, api-runtime-status 69, api-context-diagnostic 131) i runtime-context.ts (188, ApiRuntimeContext) opisują jedno wywołanie seat-u przez API: budżet tokenów, terminy, status i diagnozę za małego kontekstu. Leżą płasko wśród 32 plików providers/, obok backendów (ollama, lm-studio, llama-cpp) i katalogów.',
      before: [
        { path: 'src/engine/providers/api-budget.ts', lines: 372, note: '' },
        { path: 'src/engine/providers/api-deadlines.ts', lines: 156, note: '' },
        { path: 'src/engine/providers/api-runtime-status.ts', lines: 69, note: '' },
        { path: 'src/engine/providers/api-context-diagnostic.ts', lines: 131, note: '' },
        { path: 'src/engine/providers/runtime-context.ts', lines: 188, note: '' }
      ],
      after: [
        { path: 'src/engine/providers/api/budget.ts', lines: 372, note: '' },
        { path: 'src/engine/providers/api/deadlines.ts', lines: 156, note: '' },
        { path: 'src/engine/providers/api/runtime-status.ts', lines: 69, note: '' },
        { path: 'src/engine/providers/api/context-diagnostic.ts', lines: 131, note: '' },
        { path: 'src/engine/providers/api/runtime-context.ts', lines: 188, note: '' }
      ],
      moves: [ 'api-<x>.ts → api/<x>.ts (4 pliki)', 'runtime-context.ts → api/runtime-context.ts' ],
      tests: 'api-budget.test.ts, api-deadlines.test.ts, api-runtime-status.test.ts → api/; api-planning-budget.test.ts i api-runtime-wiring.test.ts → api/planning-budget.test.ts, api/runtime-wiring.test.ts.',
      importers: 21,
      references: [ 'docs/ARCHITECTURE.md:657-667 (lista plików providers/)' ],
      steps: [ '1. git mv pięciu plików i pięciu testów.', '2. Zmień 21 importerów (13 prod).', '3. npm run typecheck && npm run lint.' ],
      risks: 'Niskie. Nazwa folderu api/ jest zbieżna z kind: api runnera — to ten sam pojęciowo obszar, więc nie myli.'
    },
    {
      id: 'RF_ENG_31',
      kind: 'folderize',
      priority: 3,
      effort: 'M',
      risk: 'low',
      title: 'spec/plan-*.ts → spec/plan/ i prompt-formatter.ts do spec/prompts/',
      why: 'Trzy pliki z prefiksem plan- (plan-checks 418, plan-markdown 79, plan-tasks 48). prompt-formatter.ts (362) buduje prompt zadania i retry, a docs/STRUCTURE.md (Prompts folder) mówi: każdy szablon promptu żyje w spec/prompts/ — dziś ten jeden leży obok folderu prompts/. prompts/tasks.ts (7 linii, 2 stałe) importuje tylko prompts/plan-session.ts.',
      before: [
        { path: 'src/engine/spec/plan-checks.ts', lines: 418, note: 'checkPlan' },
        { path: 'src/engine/spec/plan-markdown.ts', lines: 79, note: 'formatPlanMarkdown' },
        { path: 'src/engine/spec/plan-tasks.ts', lines: 48, note: 'taskFromSpec, formatCheck, anchorAction' },
        { path: 'src/engine/spec/prompt-formatter.ts', lines: 362, note: 'formatTaskPrompt, formatRetryPrompt' },
        { path: 'src/engine/spec/prompts/tasks.ts', lines: 7, note: 'GATES_ARE_SPLITBRIEFS, SKILLS_WITH_EVERY_BRIEF' }
      ],
      after: [
        { path: 'src/engine/spec/plan/checks.ts', lines: 418, note: '' },
        { path: 'src/engine/spec/plan/markdown.ts', lines: 79, note: '' },
        { path: 'src/engine/spec/plan/tasks.ts', lines: 48, note: '' },
        { path: 'src/engine/spec/prompts/task.ts', lines: 360, note: 'dawny prompt-formatter.ts' },
        { path: 'src/engine/spec/prompts/plan-session.ts', lines: 169, note: '+ dwie stałe z prompts/tasks.ts' }
      ],
      moves: [ 'plan-checks.ts → plan/checks.ts', 'plan-markdown.ts → plan/markdown.ts', 'plan-tasks.ts → plan/tasks.ts', 'prompt-formatter.ts → prompts/task.ts', 'prompts/tasks.ts → wchłonięty przez prompts/plan-session.ts' ],
      tests: 'plan-checks.test.ts, plan-markdown.test.ts, plan-tasks.test.ts → spec/plan/; prompt-formatter.test.ts → prompts/task.test.ts.',
      importers: 35,
      references: [ 'CLAUDE.md:188', 'CONTRIBUTING.md:133', 'docs/LAYERS.md:167', 'docs/ARCHITECTURE.md:451', 'docs/ARCHITECTURE.md:695', 'docs/ARCHITECTURE.md:696', 'docs/ARCHITECTURE.md:699', 'docs/ARCHITECTURE.md:866', 'docs/ARCHITECTURE.md:867', 'docs/FEATURES.md:261', 'docs/HOW-IT-WORKS.md:142', 'docs/PLANNERS-AND-IMPLEMENTERS.md:163', 'docs/PLANNERS-AND-IMPLEMENTERS.md:326', 'docs/TASK-CONTRACT.md:65', 'docs/TASK-CONTRACT.md:69', 'docs/TASK-CONTRACT.md:130', 'docs/TROUBLESHOOTING.md:1006', 'docs/WORKFLOW.md:330', 'docs/WORKFLOW.md:331', 'scripts/skill-blocks.ts:40 (import prompt-formatter)' ],
      steps: [ '1. git mv plików i testów.', '2. Zmień importy w 35 plikach (19 prod; w tym orchestrator/planning i scripts/skill-blocks.ts).', '3. Popraw 20 miejsc w docs i CLAUDE.md:188. npm run typecheck && npm run lint && npm run skills:check.' ],
      risks: 'Niskie w kodzie, ale dużo odwołań w dokumentacji (CLAUDE.md:188 nazywa src/engine/spec/plan-checks.ts w opisie sesji planowania). Część importerów jest w orchestrator/ (inna część).'
    },
    {
      id: 'RF_ENG_32',
      kind: 'merge',
      priority: 3,
      effort: 'S',
      risk: 'low',
      title: 'Jedno toTokenDelta: calls/projection.ts i calls/usage.ts',
      why: 'Dwa sąsiednie moduły eksportują funkcję o tej samej nazwie i innym typie wejścia: calls/projection.ts:25 toTokenDelta(usage: RunnerCallResult[usage]) i calls/usage.ts:90 toTokenDelta(raw: unknown). Wołający wybierają przez ścieżkę importu (projection.js w planners/, implementers/pipeline/run.ts; usage.js w innych). projection.ts ma 28 linii; drugi eksport toInvokeResult importuje tylko 6 plików.',
      before: [
        { path: 'src/engine/calls/projection.ts', lines: 28, note: 'toInvokeResult, toTokenDelta' },
        { path: 'src/engine/calls/usage.ts', lines: 343, note: 'toTokenDelta, toProviderTokenDelta, toTokenDeltaFromRunnerCallUsage' }
      ],
      after: [ { path: 'src/engine/calls/usage.ts', lines: 365, note: '+ toInvokeResult; typowane toTokenDelta(usage | null) jako runnerCallTokenDelta' } ],
      moves: [ 'toInvokeResult → usage.ts', 'projection.ts toTokenDelta → usage.ts jako runnerCallTokenDelta (inna nazwa niż wersja z unknown)', 'usunąć projection.ts' ],
      tests: 'projection.test.ts → przypadki do usage.test.ts.',
      importers: 6,
      references: [],
      steps: [ '1. Przenieś dwie funkcje i zmień nazwę wersji typowanej.', '2. Zmień 6 importerów. npm run typecheck && npm run lint.' ],
      risks: 'Niskie. Alternatywa: zostawić projection.ts i tylko zmienić nazwę — decyzja właściciela.'
    },
    {
      id: 'RF_ENG_33',
      kind: 'move',
      priority: 3,
      effort: 'S',
      risk: 'low',
      title: 'Jednoplikowy folder reviewers/ (23 linie) → planners/reviewer.ts (decyzja właściciela)',
      why: 'reviewers/ ma jeden plik types.ts (23 linie) z portem Reviewer. Komentarz portu mówi, że planner spełnia go strukturalnie, a jedyna implementacja powstaje w runners/factory.ts:133 (createReviewer zwraca Planner). Port importuje typy z planners/types.ts. Zgodnie z LAYERS.md (Ports and adapters: port obok implementacji) dom to planners/.',
      before: [ { path: 'src/engine/reviewers/types.ts', lines: 23, note: 'Reviewer' } ],
      after: [ { path: 'src/engine/planners/reviewer.ts', lines: 23, note: 'Reviewer' } ],
      moves: [ 'reviewers/types.ts → planners/reviewer.ts', 'usunąć folder reviewers/' ],
      tests: 'Brak własnego testu; 2 testy zmieniają import.',
      importers: 11,
      references: [ 'docs/LAYERS.md:162', 'docs/ARCHITECTURE.md:98', 'docs/ARCHITECTURE.md:445', 'docs/ARCHITECTURE.md:668', 'docs/ARCHITECTURE.md:846', 'docs/PLANNERS-AND-IMPLEMENTERS.md:75' ],
      steps: [ '1. git mv; zmień 11 importerów (9 prod, 8 z nich w orchestrator/).', '2. Popraw docs. npm run typecheck && npm run lint.' ],
      risks: 'Niskie technicznie. Decyzja właściciela: trzy seat-y (planner, implementer, reviewer) mają dziś po folderze; przeniesienie łamie tę symetrię w dokumentacji (ARCHITECTURE.md:98).'
    },
    {
      id: 'RF_ENG_34',
      kind: 'move',
      priority: 3,
      effort: 'S',
      risk: 'low',
      title: 'admitCandidateEffect i CandidateEffectReceipt: kod produkcyjny używany tylko przez testy',
      why: 'providers/candidate-contract.ts:536-607 (CandidateEffectReceipt, CandidateEffectRole, CandidateEffectAdmission, admitCandidateEffect — 72 linie) nie ma importera produkcyjnego. Używają go: candidate-contract.test.ts, cli-tools/contract-harness-effects.integration.test.ts i testing/integration/orchestrator/planner-effect-matrix.test.ts. To wyrocznia testowa w kodzie produkcyjnym.',
      before: [ { path: 'src/engine/providers/candidate-contract.ts', lines: 607, note: '536-607' } ],
      after: [ { path: 'testing/helpers/candidate-effect.ts', lines: 75, note: 'CandidateEffectReceipt, admitCandidateEffect' } ],
      moves: [ 'candidate-contract.ts 536-607 → testing/helpers/candidate-effect.ts' ],
      tests: 'Przypadki admitCandidateEffect z candidate-contract.test.ts → testing/helpers/candidate-effect.test.ts albo do dwóch testów macierzy efektów.',
      importers: 3,
      references: [ 'docs/TESTING.md:174 (macierz efektów)' ],
      steps: [ '1. Potwierdź grep: brak importera w src/ poza testami.', '2. Przenieś; zmień 3 importy testów. npm run typecheck && npm run lint.' ],
      risks: 'Niskie. Jeśli właściciel planuje użycie w prod (przyjęcie efektu kandydata w runtime), zostawić w candidate/effect.ts (RF_ENG_03).'
    },
    {
      id: 'RF_ENG_35',
      kind: 'folderize',
      priority: 3,
      effort: 'S',
      risk: 'low',
      title: 'Adapter OpenCode jako folder runners/cli-tools/opencode/',
      why: 'opencode.ts (263) i opencode-steering.ts (299) to jeden adapter z prefiksem opencode. Sterowanie importuje tylko opencode.ts. Ten sam wzór co RF_ENG_24 i RF_ENG_25 (adapter z więcej niż jednym plikiem dostaje folder).',
      before: [
        { path: 'src/engine/runners/cli-tools/opencode.ts', lines: 263, note: '' },
        { path: 'src/engine/runners/cli-tools/opencode-steering.ts', lines: 299, note: '' }
      ],
      after: [
        { path: 'src/engine/runners/cli-tools/opencode/adapter.ts', lines: 263, note: '' },
        { path: 'src/engine/runners/cli-tools/opencode/steering.ts', lines: 299, note: '' }
      ],
      moves: [ 'opencode.ts → opencode/adapter.ts', 'opencode-steering.ts → opencode/steering.ts' ],
      tests: 'opencode.test.ts → opencode/adapter.test.ts; opencode-steering.test.ts → opencode/steering.test.ts.',
      importers: 11,
      references: [ 'docs/PLANNERS-AND-IMPLEMENTERS.md:451' ],
      steps: [ '1. git mv dwóch plików i testów.', '2. Zmień 11 importerów (registry.ts i testy). npm run typecheck && npm run lint.' ],
      risks: 'Niskie. kilo-code.ts importuje parse-opencode, nie adapter — bez zmian.'
    }
  ],
  keep: [
    { path: 'src/engine/events/schema.ts', lines: 900, reason: 'Jeden schemat: EngineEventPayloadSchema to jedna dyskryminowana unia po type (258-866) plus kilka podschematów. Podział na rodziny eventów rozbiłby jedno źródło prawdy zapisywane do session.jsonl; 15 miejsc w docs nazywa ten plik.' },
    { path: 'src/engine/calls/recorder.ts', lines: 767, reason: 'Jedna maszyna stanu w domknięciu: createRunnerCallRecorder (131-689) dzieli 20 zmiennych między 16 metod. Po RF_ENG_01 spada do około 725 linii. Dalszy podział wymagałby obiektu stanu bez zysku dla testów, bo metody są testowane przez kontrakt rekordera.' },
    { path: 'src/engine/detection/service.ts', lines: 565, reason: 'Jedna maszyna stanu usługi detekcji: createDetectionService (260-560) trzyma generację, oczekujące ładowania i projekcję. Pomocniki 123-254 służą tylko jej. Ewentualny podział tylko po RF_ENG_10 (usunięcie reeksportu).' },
    { path: 'src/engine/implementers/isolation/shell-paths.ts', lines: 589, reason: 'Jedna tabela danych: COMMANDS (453) i handlery komend powłoki (132-452), czytane przez readShellCommand. Handlery są małe i sens mają tylko razem z tabelą. Jedyny kandydat do wycięcia to parser argumentów (parseArgs, valuesOf, hasFlag; 30-98).' },
    { path: 'src/engine/runners/cli-tools/probe/native-catalog.ts (dziś providers/cli-model-catalog.ts)', lines: 501, reason: 'Jedna tabela parserów natywnych katalogów modeli: po jednym parse*NativeModelCatalog na narzędzie plus wspólne schematy i pomocniki linii. Przenosiny w RF_ENG_14, bez podziału.' },
    { path: 'src/engine/providers/candidate/contract.ts (po RF_ENG_03)', lines: 375, reason: 'Jeden schemat kontraktu kandydata dostawcy (endpoint policy, raw request, deskryptor, znane modele).' }
  ],
  conventions: [
    'Zmiana na main (2026-10): process-invoke.ts ma 1037 linii (odmowa konta na stderr f307dcb, argv-prompt-too-large afbb4ea), plan-checks.ts 418 (befef41), parse-stream-json.ts stracił rateLimitWarning i rateLimitResetLabel (a9f2ab9); zakresy w RF_ENG_04, 09, 12, 13, 15, 24, 31 przesunięte.',
    'Folder zamiast prefiksu w engine: grupa plików x-a.ts, x-b.ts staje się x/a.ts, x/b.ts; plik w folderze nie powtarza nazwy folderu (prepare-execution/prepare.ts, nie prepare-execution/prepare-execution.ts; conformance/shared.ts, nie conformance/conformance.ts).',
    'Adapter CLI: jeden plik cli-tools/<tool>.ts, dopóki ma do 300 linii. Gdy rośnie albo ma plik pomocniczy, dostaje folder cli-tools/<tool>/ z adapter.ts (entry: sonda + fabryka), args.ts, protocol.ts, steering.ts, conformance.ts (CLI_CONFORMANCE_CANDIDATES). Przykłady: RF_ENG_24 claude-code, RF_ENG_25 codex, RF_ENG_35 opencode.',
    'Parser protokołu: format linii współdzielony przez outputFormat runnerów shell/agent (stream-json, jsonl, text, opencode) żyje w streaming/parse/. Parser używany przez jeden adapter żyje w adapterze (codex, cursor, command-code już tak mają; parse-antigravity.ts i parse-copilot.ts mają po jednym importerze — kandydaci do przenosin do adaptera, gdy adapter dostanie folder). streaming/parse = protokół narzędzia, engine/parsers = treść odpowiedzi modelu.',
    'Polityka bezpieczeństwa (zakazane argumenty sond, redakcja poświadczeń, tożsamość pliku wykonywalnego) ma jeden dom i jeden test. Kopia polityki to defekt, nie styl (RF_ENG_02, RF_ENG_09).',
    'Ten sam algorytm na żywo i z logu (rekorder vs kolektor) dzieli funkcje reguł, a różni się tylko emisją (RF_ENG_01).',
    'Bez reeksportów w engine, także jednolinijkowych export type { X } from (RF_ENG_10).',
    'Pozostawione pary z prefiksem, których nie warto ruszać: runners/factory.ts + factory-gates.ts (factory.ts nazywa CLAUDE.md:178 i 12 miejsc w docs), codebase/cache.ts + cache-path.ts (12 linii), events/workflow-cancel.ts + workflow-events.ts, parsers/code-detection.ts + code-patterns.ts, detection/cli-catalog-outcomes.ts + cli-context.ts, calls/warnings.ts + warning-fingerprint.ts.',
    'Tożsamość narzędzia w nazwie pliku: providers/ trzyma dostawców API; kod natywnego CLI (cli-model-catalog.ts) i odkrywanie narzędzi CLI (providers/discovery.ts: discoverAllCliTools, 1 importer: detection/deps.ts) należą do runners/cli-tools/probe/ albo detection/.',
    'duplikat z utils/core: ogrodzenie bloku markdown dłuższym ciągiem backticków jest cztery razy — spec/prompts/builder.ts:37 (fenced, eksport), spec/formatter.ts:33 (fenceBlock), planners/api-context.ts:283 (fenceFor), core/review/fix-task.ts:151 (fenced). Dom: src/utils/markdown/fence.ts (czysta funkcja, bez domeny; core nie może importować engine). Do tego czasu formatter.ts i api-context.ts mogą wołać spec/prompts/builder.ts fenced.',
    'duplikat z lib/core/utils: obcięcie tekstu do prefiksu N bajtów UTF-8 jest cztery razy — calls/output-limit.ts:214 (takeUtf8PrefixBytes, eksport, ciało identyczne z lib), lib/process/bounded-output.ts:160 (takeUtf8PrefixBytes), core/payload-bounds.ts:278 (truncateRawUtf8String), providers/candidate-contract.ts:475 (truncateToCharacterBoundary). Dom: src/utils (czysta funkcja na Buffer).',
    'duplikat z lib: zawieranie ścieżki — implementers/isolation/boundary.ts:159 (isWithin), runners/resolve-cli-executable.ts:104 (isWithin) i lib/path-confinement.ts:57 (isInsideRoot). Uwaga: isInsideRoot używa startsWith(..), więc nazwę ..bin traktuje jako wyjście; obie kopie w engine używają semantyki segmentu (.. albo ..<sep>). Dom: lib/path-confinement.ts po wyborze semantyki segmentu.',
    'duplikat z core: providers/cost/breakdown.ts:64 isCliToolId jest identyczne z core/runners/cli-tool-catalog.ts:816 (eksport) — usunąć kopię (w RF_ENG_19).',
    'duplikat z core: runners/probe-availability.ts:244 envCredentialIdentity ma ten sam algorytm co core/config/accessors/runner-discovery-context.ts:58 (różni się tylko generatorem: licznik vs randomUUID). Dom: core, jeśli obie tożsamości mają być porównywalne.',
    'duplikat z utils: implementers/bundle-baseline.ts:48, apply-file-bundle.ts:37, parse-file-bundle.ts:165 piszą err instanceof Error ? err.message : String(err); utils/format-errors.ts:39 toErrorMessage robi to samo plus sanitację terminala. Zamiana zmienia tekst błędu (sanitacja) — decyzja przy RF_ENG_08.'
  ]
});
