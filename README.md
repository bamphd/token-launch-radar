# token-launch-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/bamphd/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/bamphd/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar for the make.fun bounty `token-radar-01`: 198 pre-token protocols ranked by a value model fitted to the snapshot's own trading protocols, each row carrying a rank range from 200 bootstrap refits and a dated farm plan netted to the dollar — total cost (gas, forgone yield, exit transaction), hours, break-even range, evidence, and a FARM / THIN / SKIP verdict. Every protocol in the snapshot is accounted for: 198 ranked, 144 pre-token protocols set aside by the launch rule, 416 already trading, the 40-protocol watchlist covered 40/40.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

## How the ranking works

The model learns its prices from the snapshot and tests itself before it ranks anything:

- **The comps.** 104 trading protocols with a market-cap / TVL ratio inside 0.01..10, exchanges excluded. Each votes with its market cap and its TVL.
- **The model.** A median fit (least absolute deviations, so the few comps at the ratio band's edge do not drag it): `log(market cap) = 8.4992 + 0.438 x log(TVL) + 0.1043 x within-category size`, plus one intercept shift per category and one per first chain, each shrunk by `n / (n + 4)`, so a category or chain with few comps barely moves from the shared line. Growth and age were fitted as terms and dropped — neither improves both blind tests — so no hand-set multiplier remains: implied value is `exp(model)`, rounded to whole dollars.
- **The blind tests.** Leave-one-out error 1.146 log points, against 1.382 for a flat global median. Walk-forward — fitted on the oldest 53 dated comps, tested on the newest 24 — 1.003 against 1.262 flat. Fitted growth would improve the walk-forward test to 0.924 but worsens leave-one-out to 1.179, and fitted age wrecks the walk-forward test at 1.112; a term stays only when it improves both tests, so both stay out. The record of every decision ships in `dashboard/report.md`.
- **The launch rule.** A candidate has no token on record, sits in a launchable category, and is named like a protocol: wrapped and staked products, versioned names, bridge and restaking categories, and exchange names are set aside — the same rule the snapshot's watchlist uses, applied to the whole index.
- **The rank ranges.** The model is refitted 200 times on resampled comps (fixed seed, reproducible); each row's range is the middle 80% of its refit ranks. The top rows are steady, the middle of the board moves, and the board says so.

No protocol name is hardcoded anywhere: the same fit, the same rule, and the same playbook score every row, and two runs on the same snapshot are byte-identical.

## Farm plans

Each row's six-step plan is composed from the protocol's own record — its size sets the deposit ($250 / $150 / $100 / $50), its first chain sets the gas, its age sets the hold (30–60 days), and the snapshot's date sets every calendar date on the plan. The last step nets the whole plan: total cost (gas plus forgone yield at 5% a year on the deposit plus the exit transaction), hours of attention, the break-even allocation as a share of implied value with a half-/double-gas range, and the implied dollars per cost dollar that sets the verdict. Verdicts split the board into thirds by that ratio; a top-third row whose evidence is partial (missing launch date or trading history) farms thin instead. Safety is built in: fresh wallet, revoke approvals when done, claim only from links the protocol's own official accounts publish.

## Dashboard

A static page with no network: `dashboard/index.html` + `app.css` + `app.js` read `data.js`, which `main.ts` writes from the same board, plans, and model record the judge sees — one derivation, no drift. Sortable and filterable board with rank ranges and verdicts, a per-protocol detail drawer that recomputes the row's number, shows its category and chain shifts and its nearest traded comps and comparable peers, the full calibration table, a traded-anchors tab, a compare tray for up to three protocols, and the generated `dashboard/report.md` carrying the whole model record in text.

Entry by @7billions (GitHub `bamphd`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=3r8va27c&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
