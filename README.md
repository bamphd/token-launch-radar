# token-launch-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/bamphd/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/bamphd/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar for the make.fun bounty `token-radar-01`: 198 pre-token protocols ranked by a value curve fitted to the snapshot's own trading protocols, each row carrying a rank range from 200 bootstrap refits and a dated farm plan netted to the dollar — gas, hours, break-even, and a FARM / THIN / SKIP verdict. Every protocol in the snapshot is accounted for: 198 ranked, 144 pre-token protocols set aside by the launch rule, 416 already trading, the 40-protocol watchlist covered 40/40.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

## How the ranking works

The model learns its prices from the snapshot and tests itself before it ranks anything:

- **The comps.** 104 trading protocols with a market-cap / TVL ratio inside 0.01..10, exchanges excluded. Each votes with its market cap and its TVL.
- **The curve.** `log(market cap) = 5.0002 + 0.6349 x log(TVL)`, plus one intercept shift per category shrunk by `n / (n + 4)`, so a category with few comps barely moves from the shared line. Growth is the seven-day change clamped to -60..120 at full weight; age is a gentle `(1 + age / 365) ^ 0.05`, capped at three years.
- **The blind tests.** Leave-one-out error 1.190 log points, against 1.382 for a flat global median and 1.440 for per-category medians. Walk-forward — fitted on the oldest 53 dated comps, tested on the newest 24 — 1.045 against 1.262 flat. A stronger age term raises the error, so the term stays small; the record of every decision ships in `dashboard/report.md`.
- **The launch rule.** A candidate has no token on record, sits in a launchable category, and is named like a protocol: wrapped and staked products, versioned names, bridge and restaking categories, and exchange names are set aside — the same rule the snapshot's watchlist uses, applied to the whole index.
- **The rank ranges.** The curve is refitted 200 times on resampled comps (fixed seed, reproducible); each row's range is the middle 80% of its refit ranks. The top rows are steady, the middle of the board moves, and the board says so.

No protocol name is hardcoded anywhere: the same fit, the same rule, and the same playbook score every row, and two runs on the same snapshot are byte-identical.

## Farm plans

Each row's six-step plan is composed from the protocol's own record — its size sets the deposit ($250 / $150 / $100 / $50), its first chain sets the gas, its age sets the hold (30–60 days), and the snapshot's date sets every calendar date on the plan. The last step nets the whole plan: total gas, hours of attention, the break-even allocation as a share of implied value, and the implied dollars per gas dollar that sets the verdict. Verdicts split the board into thirds by that ratio. Safety is built in: fresh wallet, revoke approvals when done, claim only from links the protocol's own official accounts publish.

## Dashboard

A static page with no network: `dashboard/index.html` + `app.css` + `app.js` read `data.js`, which `main.ts` writes from the same board, plans, and model record the judge sees — one derivation, no drift. Sortable and filterable board with rank ranges and verdicts, a per-protocol detail drawer that recomputes the row's number and shows its nearest traded comps, the full calibration table, a traded-anchors tab, a compare tray for up to three protocols, and the generated `dashboard/report.md` carrying the whole model record in text.

Entry by @7billions (GitHub `bamphd`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=3r8va27c&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
