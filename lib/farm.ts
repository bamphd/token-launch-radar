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
  /** Forgone yield on the deployed deposit at a stated 5% a year, over the hold. */
  opportunity_cost_usd: number;
  /** One more transaction at the chain's gas rate, to exit the position. */
  exit_fee_usd: number;
  /** Everything the farm costs: gas plus forgone yield plus the exit transaction. */
  total_cost_usd: number;
  /** Break-even allocation when gas runs at half price, and at double price. */
  break_even_low_usd: number;
  break_even_high_usd: number;
  /** Whether the plan's inputs are all on record, or part of them is unrecorded. */
  evidence_status: 'supported' | 'partial';
  /** The decisive reason for the verdict, beside the verdict itself. */
  verdict_reason: string;
  /** Peer-implied expected value: implied value times the published token-recorded odds. Not a payout forecast. */
  expected_value_usd: number;
  /** Expected value net of total cost, per hour of attention: (EV - cost) / hours. The verdict's ratio in radar-5. */
  net_per_hour_usd: number;
  /** Net per hour if the user's own gross reward were $0, $50, $250, or $1,000: (reward - cost) / hours. */
  reward_scenarios: Array<{ reward_usd: number; net_per_hour_usd: number }>;
}

/** The forgone yield assumed on deployed capital, a year of it. */
export const OPPORTUNITY_APY = 0.05;

/** One plan's cost parts: the gas across the hold, the forgone yield, the exit transaction, and their sum. */
export function costParts(p: Protocol, ageDays: number | null): {
  gas_total: number;
  opportunity: number;
  exit_fee: number;
  total: number;
} {
  const gasTx = gasFor(p.chains);
  const hold = holdDays(ageDays);
  const weeks = Math.max(1, Math.ceil(hold / 7));
  const gasTotal = gasTx * (1 + 2 + weeks + 1);
  const opportunity = roundTo(depositFor(p.tvl_usd) * OPPORTUNITY_APY * (hold / 365), 2);
  return { gas_total: gasTotal, opportunity, exit_fee: gasTx, total: roundTo(gasTotal + opportunity + gasTx, 2) };
}

/** The whole cost of farming a protocol: gas plus forgone yield plus the exit transaction. */
export function totalCostFor(p: Protocol, ageDays: number | null): number {
  return costParts(p, ageDays).total;
}

/** The attention a plan asks for, in hours: set up, open, weekly tending, claim, settle. */
export function planHours(ageDays: number | null): number {
  const weeks = Math.max(1, Math.ceil(holdDays(ageDays) / 7));
  return roundTo(0.25 + 0.5 + weeks * 0.25 + 0.25 + 0.1, 2);
}

/** Whether the plan's evidence is complete: a listing date and at least one chain on record. */
export function evidenceStatus(p: Protocol, ageDays: number | null): 'supported' | 'partial' {
  if (ageDays === null || p.chains.length === 0) return 'partial';
  return 'supported';
}

/**
 * The verdict the board prints: the efficiency third, except a top-third row whose
 * evidence is partial farms thin instead — weak evidence caps the verdict, it never
 * raises one. A middle or bottom row keeps its third whatever the evidence says.
 */
export function finalVerdict(tercile: 'FARM' | 'THIN' | 'SKIP', evidence: 'supported' | 'partial'): 'FARM' | 'THIN' | 'SKIP' {
  if (tercile === 'FARM' && evidence === 'partial') return 'THIN';
  return tercile;
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
 * alone: the reader sees the number the word rests on. The break-even is the reward
 * the allocation must be worth to cover the whole cost; no expected payout is
 * manufactured, because the snapshot carries no allocation evidence.
 */
export function buildFarmPlan(
  p: Protocol,
  ageDays: number | null,
  asOf: string,
  impliedUsd: number,
  expectedUsd: number,
  tercile: 'FARM' | 'THIN' | 'SKIP',
  efficiency: number,
): FarmPlan {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const deposit = depositFor(p.tvl_usd);
  const gasTx = gasFor(p.chains);
  const hold = holdDays(ageDays);
  const weeks = Math.max(1, Math.ceil(hold / 7));
  const weeklyGas = gasTx;
  const parts = costParts(p, ageDays);
  const gasTotal = parts.gas_total;
  const hours = planHours(ageDays);
  const holdEnd = plusDays(asOf, hold);
  const opportunity = parts.opportunity;
  const exitFee = parts.exit_fee;
  const totalCost = parts.total;
  const breakEven = totalCost;
  const breakEvenLow = roundTo(0.5 * (gasTotal + exitFee) + opportunity, 2);
  const breakEvenHigh = roundTo(2 * (gasTotal + exitFee) + opportunity, 2);
  const breakEvenShare = roundTo((breakEven / Math.max(1, impliedUsd)) * 100, 6);
  const evidence = evidenceStatus(p, ageDays);
  const verdict = finalVerdict(tercile, evidence);
  const netPerHour = roundTo((expectedUsd - totalCost) / hours, 2);
  const scenarios = [0, 50, 250, 1000].map((reward) => ({
    reward_usd: reward,
    net_per_hour_usd: roundTo((reward - totalCost) / hours, 2),
  }));
  const reason =
    verdict === 'FARM'
      ? `top third by expected value per hour ($${netPerHour.toLocaleString('en-US')}/h net of cost; ${Math.round(efficiency).toLocaleString('en-US')} expected dollars per cost dollar), break-even $${Math.round(breakEven)} is ${breakEvenShare}% of implied value.`
      : verdict === 'THIN' && tercile === 'FARM'
        ? `top third on expected value per hour, but the plan's evidence is partial (${ageDays === null ? 'no listing date on record' : 'no chain on record'}), so it farms thin.`
        : verdict === 'THIN'
          ? `middle third by expected value per hour ($${netPerHour.toLocaleString('en-US')}/h net of cost): worth it only if the chain stays cheap.`
          : `bottom third by expected value per hour ($${netPerHour.toLocaleString('en-US')}/h net of cost): the cost buys too little expected value.`;
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
      `Settle up: ${money(totalCost)} total cost (${money(gasTotal)} gas, ${money(opportunity)} forgone yield, ${money(exitFee)} to exit), break-even ${money(breakEven)} (low ${money(breakEvenLow)}, high ${money(breakEvenHigh)}) against ${money(Math.round(impliedUsd))} implied and ${money(Math.round(expectedUsd))} peer-implied expected value — $${netPerHour.toLocaleString('en-US')} net per hour over ${hours} hours. Verdict: ${verdict}.`,
      `${money(totalCost)} all in; the ${money(deposit)} deposit returns on exit`,
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
      opportunity_cost_usd: opportunity,
      exit_fee_usd: exitFee,
      total_cost_usd: totalCost,
      break_even_low_usd: breakEvenLow,
      break_even_high_usd: breakEvenHigh,
      evidence_status: evidence,
      verdict_reason: reason,
      expected_value_usd: Math.round(expectedUsd),
      net_per_hour_usd: netPerHour,
      reward_scenarios: scenarios,
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
