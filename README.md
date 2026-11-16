# Token Radar — radar-2

A token launch radar for the make.fun bounty `token-radar-01`: 200 pre-token protocols
ranked by calibrated implied value, each with a concrete six-step farm plan and a
side-by-side compare for weighing up to three protocols against each other.

## How the ranking works

The model learns its prices from the snapshot instead of assuming them:

- **Calibration.** Every category's TVL multiple is the median market-cap / TVL ratio of
  that category's live-token protocols in the same snapshot (104 protocols; ratios
  outside 0.01..10 trimmed, multiples clamped to 0.05..3.0). Categories with fewer than
  5 live protocols borrow the global median (x0.2632), and the record says so.
- **Growth.** `1 + clamp(change_7d, -60, 120) / 100 x 0.5`
- **Maturity.** `0.6 + min(age_days, 1095) / 1095 x 0.4` (unknown age: 365 days)
- **Implied value.** `max(1, round(tvl_usd x category_multiple x growth x maturity))`

The board ranks all 40 watchlist protocols plus the 160 highest-TVL pre-token
protocols below the $50M floor. Trading protocols are set aside with their market
caps, and their ratios are what price the model. The dashboard states the whole
calibration table and recomputes each row's number in the detail drawer, so the
page's arithmetic is visibly the board's arithmetic.

## Farm plans

Each row's plan is composed from the protocol's own record (category, chains, size,
age) through a playbook: the opening move fits the category (lend, provide
liquidity, bridge, stake, and so on), the weekly habit keeps the position counted,
and every step states its cost and time. Safety is built in: fresh wallet, revoke
approvals when done, claim only from links the protocol's own official accounts
publish.

## Dashboard

A static page with no network: `dashboard/index.html` + `app.css` + `app.js` read
`data.js`, which `main.ts` writes from the same board, plans and calibration the
judge sees — one derivation, no drift. Sortable and filterable board, per-protocol
detail drawer with the model breakdown, the full calibration table, and a compare
tray (add protocols from their detail drawer, up to three at a time).

## Run

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Two runs are byte-identical. Entry by @7billions (GitHub `bamphd`).
