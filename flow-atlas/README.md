# Flow Atlas

Lokalna strona, która pokazuje każdy przepływ i każdą decyzję SPLITBRIEF: diagramy Mermaid, karty decyzji, odpowiedzi na częste pytania, konfigurację, scenariusze, słownik i strukturę kodu.

- **Mapa** zaczyna od diagramu całego runu (pierwszy diagram obszaru `journey`). Pod nim są najważniejsze odpowiedzi, etapy runu z wyjściami bocznymi i macierz przejść między obszarami. Gęsty graf wszystkich przejść jest zwinięty na dole.
- **Pytania (FAQ)** odpowiadają wprost na pytania typu „co się dzieje, gdy walnie limit”. Każda odpowiedź linkuje karty decyzji, diagramy i obszary, na których się opiera.

## Jak otworzyć

Otwórz `flow-atlas/index.html` w przeglądarce prosto z dysku (`file://`). Nie ma kroku budowania.

- Diagramy rysuje Mermaid 11.4.1 z CDN jsdelivr. Bez sieci strona działa, a każdy diagram pokazuje swoje źródło.
- Adres w pasku jest zakładką: `#view/map`, `#view/faq`, `#view/faq/q-<id>` (jedno pytanie, rozwinięte), `#view/decisions`, `#view/config`, `#view/scenarios`, `#view/structure`, `#view/glossary`, `#area/recovery`, `#decision/RC_ACCOUNT_CAUSE`, `#diagram/<id>`.
- `/` przenosi kursor do wyszukiwarki. Strzałki i Enter wybierają wynik.
- Kliknięcie romba na diagramie otwiera kartę decyzji. Najechanie na kartę podświetla jej romb.
- Kliknięcie chipa `plik:linia` kopiuje go do schowka. Strzałka `↗` obok otwiera plik w edytorze. Edytor (VS Code, Cursor albo brak linku) wybierasz na dole paska bocznego.
- Diagram startuje w skali „do szerokości karty”, ale nigdy poniżej 60%; szerszy diagram przewijasz w poziomie. Ramka ma najwyżej 80% wysokości okna; wyższy diagram przewijasz w ramce albo otwierasz przyciskiem „otwórz na pełnym ekranie”.
- Diagram: Ctrl + kółko to zoom, przeciągnięcie przesuwa, „dopasuj” wraca do skali startowej. Pełny ekran otwiera diagram na szerokość okna od góry; „cały diagram” pokazuje go w całości (Esc zamyka).
- Wyszukiwarka przeszukuje też pytania FAQ i stawia je na czele wyników.

## Jak sprawdzić dane

```bash
node flow-atlas/check.mjs
```

Skrypt sprawdza:

1. schemat każdego pliku danych: wymagane pola, unikalne id w całym atlasie (obszary, diagramy, decyzje), linki do istniejących obszarów, węzły `tree`;
2. plik `data/faq.js`: czy się wykonuje, unikalne id pytań, pola `q` i `a`, 3-8 zdań w odpowiedzi (uwaga), czy każdy `ref` wskazuje istniejącą decyzję, obszar albo diagram, i czy id decyzji wspomniane w tekście odpowiedzi istnieją;
3. id decyzji i pytań, które `app.js` wpisuje na Mapę (karty etapów, `TOP_FAQ`);
4. każde `where`, `entry`, `files.path` i `tree.path`: plik istnieje, a linia nie przekracza długości pliku;
5. render każdego diagramu w Chromium (Playwright) z treścią błędu Mermaid;
6. romby z id decyzji bez karty (błąd) i karty decyzji, których nie ma na żadnym diagramie (uwaga).

Kod wyjścia 1 oznacza błędy. Opcje:

- `--data <katalog>` — inny katalog z plikami danych,
- `--repo <katalog>` — inny korzeń repozytorium dla ścieżek,
- `--no-render` — bez Chromium,
- `--verbose` — także romby, które nie są decyzjami.

Gdy Chromium nie dosięga CDN, podaj lokalną kopię Mermaid:

```bash
MERMAID_JS=/ścieżka/do/mermaid.min.js node flow-atlas/check.mjs
```

Kopię pobierzesz poza repozytorium, na przykład `npm pack mermaid@11.4.1` w katalogu tymczasowym i `tar xzf mermaid-11.4.1.tgz`. Plik leży w `package/dist/mermaid.min.js`.

## Jak dodać albo rozszerzyć plik danych

Kontrakt opisuje [SCHEMA.md](./SCHEMA.md). W skrócie:

1. Plik to `flow-atlas/data/<id>.js`, zwykły skrypt, który robi `window.ATLAS.push({...})` z jednym obszarem. `id` równa się nazwie pliku.
2. Nowy obszar dopisz w trzech miejscach: znacznik `<script src="data/<id>.js">` w `index.html`, lista `AREAS` na początku `app.js`, lista `EXPECTED` w `check.mjs`.
3. Romb decyzji na diagramie ma id równe `id` karty decyzji (`RC_CAUSE{"Jaka przyczyna?"}`). Tylko wtedy strona łączy romb z kartą.
4. `next` w gałęzi może wskazać id decyzji albo id obszaru; strona zrobi z niego link.
5. Obszar `journey` może mieć `glossary` (widok Słownik). Obszar `structure` ma `tree` (widok Struktura).
6. Po każdej zmianie uruchom `node flow-atlas/check.mjs` i popraw błędy.

## Jak dodać albo zmienić pytanie FAQ

Pytania leżą w `flow-atlas/data/faq.js`. To osobny plik, który dopisuje wpisy do `window.ATLAS_FAQ`, a nie do `window.ATLAS`:

```js
window.ATLAS_FAQ = window.ATLAS_FAQ || [];
window.ATLAS_FAQ.push({
  id: 'limit',                       // kebab-case, unikalne; adres #view/faq/q-limit
  q: 'Co się dzieje, gdy walnie limit konta?',
  a: 'Pierwsze zdanie to wprost odpowiedź. Potem 2-7 krótkich zdań szczegółów.',
  refs: ['JR_SEAT_CLASS', 'area:recovery', 'diagram:journey-seat-failure'],
  tags: ['limity', 'fallback']       // pierwszy tag wybiera grupę w widoku
});
```

- Odpowiedź pisz tylko z tego, co mówią pliki danych: decyzje, scenariusze, pułapki. Każdą decyzję, diagram i obszar, na którym opiera się odpowiedź, podaj w `refs`.
- Pierwsze zdanie odpowiedzi jest jej skrótem: widać je pod pytaniem na liście i na kafelku Mapy. Strona dzieli odpowiedź na zdania; każde zdanie poza pierwszym jest osobnym punktem.
- `` `kod` `` i id decyzji w tekście działają jak w innych plikach danych; id decyzji staje się linkiem.
- Grupy i ich kolejność to lista `FAQ_TAGS` w `app.js` (`limity`, `fallback`, `recovery`, `stop`, `start`, `planowanie`, `build`, `review`, `apply`, `pliki`). Pytanie z innym pierwszym tagiem trafia do grupy „Inne”.
- Sześć kafelków „Najważniejsze odpowiedzi” na Mapie to lista `TOP_FAQ` w `app.js`.
