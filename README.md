# Token Radar — radar-2

A token launch radar for the make.fun bounty `token-radar-01`: 200 pre-token protocols
ranked by calibrated implied value, each with a concrete 6-step farm plan.

## Model (radar-2)

Implied value is calibrated against the snapshot itself, not assumed:

- **Category multiple**: the median market-cap / TVL ratio of the snapshot's live-token
  protocols in each category (104 protocols, ratios outside 0.01..10 trimmed, multiples
  clamped to 0.05..3.0). Categories with fewer than 5 live protocols fall back to the
  global median (x0.2632), so no single protocol sets a category's price.
- **Growth**: `1 + clamp(change_7d, -60, 120) / 100 x 0.5`
- **Maturity**: `0.6 + min(age_days, 1095) / 1095 x 0.4` (unknown age: 365 days)
- `implied = max(1, round(tvl_usd x category_multiple x growth x maturity))`

The board covers all 40 watchlist protocols plus the 160 highest-TVL pre-token
protocols below the $50M floor. Live-token protocols are set aside with their market
caps shown, and their ratios price the model.

## Dashboard

Static page, no network: `dashboard/index.html` + `app.css` + `app.js` read `data.js`
(written by `main.ts` from the same board, farm plans and calibration included, so the
page renders exactly what the board carries). Sortable/filterable board, per-protocol
detail drawer with the model breakdown and farm plan, and the full calibration table.

## Run

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Runs twice byte-identical. Entry by @7billions (GitHub `bamphd`).
