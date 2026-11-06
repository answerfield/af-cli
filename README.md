# af-cli

answerfield ist eine typisierte, deklarativ-reaktive Sprache für digitale Assessments. Dieses Repository enthält die Kommandozeile `af` mit Import und Export.

## Pakete

| Paket | Inhalt |
|---|---|
| `@answerfield/cli` | Kommandozeile `af` |
| `@answerfield/import-iqb` | Import aus dem IQB-Format |
| `@answerfield/export-typst` | Export nach Typst und PDF |

Die Pakete liegen als Dateien an den [Releases](https://github.com/answerfield/af-cli/releases).

## Bauen und testen

Voraussetzung ist Node.js 22.12 oder neuer.

```sh
npm ci && npm run build && npm test
```

## Lizenzen

| Pfad | Lizenz |
|---|---|
| Code | Apache-2.0 |

Die Lizenz jeder Datei steht in `REUSE.toml`, die Lizenztexte liegen in `LICENSES/`.

## Mitwirken

Issues und Pull Requests sind willkommen, siehe [CONTRIBUTING.md](CONTRIBUTING.md).
