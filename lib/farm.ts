// Farm plans, costed and dated. Every row carries the same six-step arc — set up, take
// the position, stay active, hold, claim safely, and the economics in one place — but
// the numbers inside it come from the protocol's own record: its size sets the deposit,
// its chains set the gas, its age sets the hold, and the snapshot's date sets every
// calendar date on the plan. Costs are planning estimates, stated as such in the
// methodology; the deposit itself is capital at work, not a fee, and the plan says so.
//
// The verdict is arithmetic, not taste: implied value per gas dollar, split into thirds
// across the board. The top third farms, the middle third is thin, the bottom third is
// a skip — and the plan prints the ratio the verdict rests on, so the reader can
// disagree with the line instead of guessing at it.

import { clampNum, plusDays, roundTo } from './snapshot.ts';
import type { Protocol } from './snapshot.ts';

/** Planning gas estimates in whole US dollars per transaction, by chain. Estimates, not quotes. */
export const GAS_PER_TX: Record<string, number> = {
  Ethereum: 14,
  Arbitrum: 2,
  Optimism: 2,
  Base: 1,
  Solana: 1,
  'BNB Chain': 1,
  Polygon: 1,
  Avalanche: 2,
  Blast: 1,
  Scroll: 1,
  Linea: 1,
  zkSync: 1,
  Gnosis: 1,
  Fantom: 1,
  Kava: 1,
};
export const GAS_DEFAULT_TX = 3;

/** Deposit tiers: the richer the protocol, the larger the position that still reads as one farmer among many. */
export const DEPOSIT_TIERS: Array<[number, number]> = [
  [1_000_000_000, 250],
  [100_000_000, 150],
  [25_000_000, 100],
];
export const DEPOSIT_FLOOR = 50;

/** Hold windows in days by age: younger protocols need longer to prove the activity is real. */
export function holdDays(ageDays: number | null): number {
  if (ageDays === null) return 45;
  if (ageDays < 180) return 60;
  if (ageDays < 365) return 45;
  return 30;
}

/** The deposit for a protocol of this TVL: the richest tier it qualifies for, else the floor. */
export function depositFor(tvlUsd: number): number {
  for (const [floor, deposit] of DEPOSIT_TIERS) {
    if (tvlUsd >= floor) return deposit;
  }
  return DEPOSIT_FLOOR;
}

/** The planning gas cost of one transaction on the protocol's first chain. */
export function gasFor(chains: string[]): number {
  const first = chains.length > 0 ? chains[0]! : '';
  return GAS_PER_TX[first] ?? GAS_DEFAULT_TX;
}

/** The plan's economics, netted: cash cost, attention, break-even, and the verdict's ratio. */
export interface FarmEconomics {
  deposit_usd: number;
  gas_usd: number;
  weekly_gas_usd: number;
  hours: number;
  hold_days: number;
  start_date: string;
  hold_end_date: string;
  break_even_usd: number;
  break_even_share_pct: number;
  efficiency: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
}

/** A farm plan: six dated steps plus the economics they add up to. */
export interface FarmPlan {
  steps: string[];
  economics: FarmEconomics;
}

/** One playbook row: how a kind of protocol is farmed, in the category's own terms. */
interface PlaybookRow {
  keywords: string[];
  open: (name: string, capital: number, chain: string) => string;
  habit: string;
}

const PLAYBOOK: PlaybookRow[] = [
  {
    keywords: ['lend', 'cdp', 'collateral', 'uncollateralized'],
    open: (name, capital, chain) => `Supply $${capital} of stablecoins to ${name}'s lending market on ${chain}; keep the supply in place and let the position accrue.`,
    habit: 'supply a small extra amount, borrow a little against it, and repay the borrow before the week ends',
  },
  {
    keywords: ['dex', 'liquidity manager', 'farm', 'leveraged'],
    open: (name, capital, chain) => `Provide $${capital} of liquidity to ${name}'s deepest pool on ${chain} and leave the position earning fees.`,
    habit: 'rebalance a slice of the position or add a little fresh liquidity, so the pool records new activity',
  },
  {
    keywords: ['bridge', 'cross chain'],
    open: (name, capital, chain) => `Bridge $${capital} of stablecoins into ${chain} through ${name}, then use the bridged funds inside the protocol's own app rather than bridging straight back.`,
    habit: 'bridge a small amount in the other direction and put it to use on arrival',
  },
  {
    keywords: ['stak', 'restak', 'validator'],
    open: (name, capital, chain) => `Stake $${capital} through ${name} on ${chain} and hold the receipt token; do not unstake inside the hold window.`,
    habit: 'check the receipt and compound whatever rewards have accrued',
  },
  {
    keywords: ['perpetual', 'derivative', 'basis', 'interest rate'],
    open: (name, capital, chain) => `Post $${capital} of stablecoins as margin on ${name} and open one small hedged position; keep leverage low enough that a normal week cannot liquidate it.`,
    habit: 'close the hedge, reopen it, and leave the margin posted',
  },
  {
    keywords: ['prediction'],
    open: (name, capital, chain) => `Fund $${capital} on ${name} and take one position in a market resolving after the hold window, on ${chain}.`,
    habit: 'settle one position and open the next, keeping funds deployed throughout',
  },
  {
    keywords: ['curator', 'allocator', 'vault', 'yield aggregator'],
    open: (name, capital, chain) => `Deposit $${capital} into a ${name} vault on ${chain} and hold the vault shares for the whole window.`,
    habit: 'review the vault allocation and add a small top-up when the strategy rotates',
  },
  {
    keywords: ['stable', 'dual-token'],
    open: (name, capital, chain) => `Mint or acquire $${capital} of ${name}'s stable asset on ${chain} and hold it in the farming wallet.`,
    habit: 'mint or redeem a small amount so the position shows continued use',
  },
  {
    keywords: ['rwa', 'real world'],
    open: (name, capital, chain) => `Acquire $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it; read the backing disclosure before buying.`,
    habit: 'read the latest backing report and keep the holding in place',
  },
  {
    keywords: ['insurance', 'cover'],
    open: (name, capital, chain) => `Purchase $${capital} of cover through ${name} on ${chain} and keep the policy active for the whole window.`,
    habit: 'confirm the cover and its expiry are still in force',
  },
  {
    keywords: ['governance', 'incentive'],
    open: (name, capital, chain) => `Lock or delegate $${capital} through ${name} on ${chain} and vote in the next proposal that opens.`,
    habit: 'vote on one live proposal each week the position is held',
  },
  {
    keywords: [],
    open: (name, capital, chain) => `Deposit $${capital} of stablecoins into ${name}'s main product on ${chain} and leave the position open for the whole window.`,
    habit: 'make one qualifying on-chain move — a deposit, a swap, a vote, or a claim',
  },
];

/** The playbook row a category matches: the first row with a keyword in it, else the default row. */
function playbookFor(category: string | null): PlaybookRow {
  const c = (category ?? '').toLowerCase();
  for (const row of PLAYBOOK) {
    if (row.keywords.length > 0 && row.keywords.some((k) => c.includes(k))) return row;
  }
  return PLAYBOOK[PLAYBOOK.length - 1]!;
}

/** A step flattened for the board: the deed, then its cost and time, inside the gate's length band. */
export function stepLine(text: string, cost: string, time: string): string {
  let s = `${text} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Keep the position open and check the protocol's own page for updates.`;
  return s;
}

const money = (n: number): string => `$${Math.round(n)}`;

/**
 * A protocol's farm plan, composed from its own record and the model's number for it.
 * The six steps walk one arc — set up, open, tend weekly, hold, claim, settle up — with
 * a calendar date on the dated steps, a dollar cost on every step, and the whole plan's
 * economics netted in the last step. The verdict arrives with the plan's ratio, never
 * alone: the reader sees the number the word rests on.
 */
export function buildFarmPlan(
  p: Protocol,
  ageDays: number | null,
  asOf: string,
  impliedUsd: number,
  verdict: 'FARM' | 'THIN' | 'SKIP',
  efficiency: number,
): FarmPlan {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const deposit = depositFor(p.tvl_usd);
  const gasTx = gasFor(p.chains);
  const hold = holdDays(ageDays);
  const weeks = Math.max(1, Math.ceil(hold / 7));
  const weeklyGas = gasTx;
  const gasTotal = gasTx * (1 + 2 + weeks + 1);
  const hours = roundTo(0.25 + 0.5 + weeks * 0.25 + 0.25 + 0.1, 2);
  const holdEnd = plusDays(asOf, hold);
  const breakEven = gasTotal;
  const breakEvenShare = roundTo((breakEven / Math.max(1, impliedUsd)) * 100, 6);
  const play = playbookFor(p.category);
  const steps = [
    stepLine(
      `Set up a fresh wallet holding only this farm's funds (${asOf}), keep its recovery phrase offline, and plan to revoke the app's token approval when the position closes.`,
      `about ${money(gasTx)} of gas for the first transaction`,
      '15 minutes',
    ),
    stepLine(play.open(p.name, deposit, chain), `${money(deposit)} of capital plus about ${money(gasTx * 2)} of gas`, '30 minutes'),
    stepLine(
      `Every week from ${plusDays(asOf, 7)} until ${holdEnd}, ${play.habit}.`,
      `about ${money(weeklyGas)} of gas a week, ${money(weeklyGas * weeks)} across ${weeks} weeks`,
      '15 minutes a week',
    ),
    stepLine(
      `Hold the position untouched for ${hold} days, until ${holdEnd}, so the activity lands in more than one snapshot.`,
      `the ${money(deposit)} stays deployed; no further fees while holding`,
      `${hold} days`,
    ),
    stepLine(
      'When claiming, reach the points or rewards page only through a link the protocol posts on its own official X or Discord account — never a DM, never a search ad — and never pay anyone to claim.',
      'no fee to check; one claim transaction at the usual gas price',
      '15 minutes',
    ),
    stepLine(
      `Settle up: ${money(gasTotal)} of gas all in, ${hours} hours of attention over ${hold} days, break-even if the allocation is worth ${money(breakEven)} (${breakEvenShare}% of the $${Math.round(impliedUsd).toLocaleString('en-US')} implied value), ${Math.round(efficiency).toLocaleString('en-US')} implied dollars per gas dollar. Verdict: ${verdict}.`,
      `${money(gasTotal)} of gas; the ${money(deposit)} deposit returns on exit`,
      `${hours} hours across ${hold} days`,
    ),
  ];
  return {
    steps,
    economics: {
      deposit_usd: deposit,
      gas_usd: gasTotal,
      weekly_gas_usd: weeklyGas,
      hours,
      hold_days: hold,
      start_date: asOf,
      hold_end_date: holdEnd,
      break_even_usd: breakEven,
      break_even_share_pct: breakEvenShare,
      efficiency: Math.round(efficiency),
      verdict,
    },
  };
}

/** The efficiency cut points that split a board into verdict thirds, from its own distribution. */
export function verdictCuts(efficiencies: number[]): { farm_above: number; skip_below: number } {
  const ordered = efficiencies.slice().sort((a, b) => a - b);
  const low = ordered[Math.floor(ordered.length / 3)]!;
  const high = ordered[Math.floor((2 * ordered.length) / 3)]!;
  return { farm_above: high, skip_below: low };
}

/** A verdict from an efficiency and the board's cut points: top third farms, bottom third skips. */
export function verdictFor(efficiency: number, cuts: { farm_above: number; skip_below: number }): 'FARM' | 'THIN' | 'SKIP' {
  if (efficiency >= cuts.farm_above) return 'FARM';
  if (efficiency < cuts.skip_below) return 'SKIP';
  return 'THIN';
}

/** A traded comp close to a row: the kin the row's curve price leans on. */
export interface Kin {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  ratio: number;
}

/**
 * The three comps nearest a protocol: same-category comps within two log units of its
 * TVL first, then every comp by distance in log TVL. Kin must be near — a same-category
 * comp a hundred times smaller is not the row's neighbourhood, whatever its label —
 * and the table names each kin's category so the reader sees the mix. Kin are the row's
 * evidence, not its price: the curve does the pricing.
 */
export function kinFor(p: Protocol, comps: Protocol[]): Kin[] {
  const target = Math.log(p.tvl_usd);
  const scored = comps.map((q) => {
    const distance = Math.abs(Math.log(q.tvl_usd) - target);
    return { q, nearSame: q.category === p.category && distance <= 2, distance };
  });
  scored.sort((a, b) => {
    if (a.nearSame !== b.nearSame) return a.nearSame ? -1 : 1;
    if (a.distance !== b.distance) return a.distance - b.distance;
    return a.q.slug < b.q.slug ? -1 : 1;
  });
  return scored.slice(0, 3).map(({ q }) => ({
    slug: q.slug,
    name: q.name,
    category: q.category,
    tvl_usd: q.tvl_usd,
    mcap_usd: q.mcap_usd!,
    ratio: roundTo(q.mcap_usd! / q.tvl_usd, 4),
  }));
}

/** Clamp a number into a band, for the economics that must never read absurd. */
export function band(n: number, low: number, high: number): number {
  return clampNum(n, low, high);
}
