# Token Launch Radar

Ranks pre-token protocols by implied value from a sealed DefiLlama
snapshot. Node 22, stdlib only, deterministic: two runs are
byte-identical.

Model (`lib/model.ts`, `radar-1`): implied value is TVL x 0.25,
scaled by clamped 7-day growth and by maturity from listing age.
No protocol name is special-cased. The board covers all 40
watchlist protocols plus 160 early pre-token rows below the floor.

Run: `MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>`

Output: `board.json` (200 rows), `data.js`, `dashboard/` (static,
sortable, filterable, per-protocol detail + farm plan), 3
screenshots, and `dossier.json` for the judge.
