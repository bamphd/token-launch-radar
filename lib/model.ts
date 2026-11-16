// Radar-2's scoring engine: a frozen DefiLlama snapshot goes in, a ranked board of pre-token
// protocols comes out, and every number on the board can be traced back to the snapshot's own
// figures. Nothing here names a protocol, consults a price feed, or reaches the network: the
// snapshot is the whole world, and the same bytes in always produce the same board out.
//
// How a row earns its place:
//   1. Calibration. The live-token protocols in the snapshot vote on what a dollar of TVL is
//      worth: each category's multiple is the median market-cap / TVL ratio of its live
//      protocols, with thin categories borrowing the global median. Outlier ratios are
//      trimmed, multiples are clamped, and a lone protocol can never price a category.
//   2. Scoring. Implied value is TVL times the category multiple, lifted by recent growth
//      and by maturity (how long the protocol has run with no token). One function scores
//      every row, so the ranking is a comparison, not a list of opinions.
//   3. Selection. The watchlist is the floor: every slug on it is ranked. Below the floor,
//      the 160 highest-TVL rankable pre-token protocols join as the early radar. Live-token
//      protocols are set aside with their market caps, never ranked, and their ratios are
//      what price the model.
//   4. Farm plans. Each row carries a six-step plan derived from its own record (category,
//      chains, size, age): what to do, what it costs, how long it takes. The dashboard
//      renders these strings verbatim from data.js, so the plan the page shows is the plan
//      the board carries, with no second derivation to drift.

/** One protocol as the sealed snapshot records it: ten fields, no more. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The snapshot document: the as-of date, the floor, the index, and the watchlist. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/**
 * The model's tuning: growth and maturity weights, the calibration bands, and the sample
 * floor. The multiple itself is deliberately absent: it is measured from the snapshot,
 * never tuned.
 */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  calibration_min_samples: number;
  calibration_ratio_min: number;
  calibration_ratio_max: number;
  calibration_multiple_min: number;
  calibration_multiple_max: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  calibration_min_samples: 5,
  calibration_ratio_min: 0.01,
  calibration_ratio_max: 10,
  calibration_multiple_min: 0.05,
  calibration_multiple_max: 3.0,
};

/** The version the dashboard prints beside the model's name. */
export const MODEL_VERSION = 'radar-2';

/** Early-radar depth: how many below-floor protocols join the board, richest first. */
export const EARLY_ROWS = 160;

/** Live-view depth: how many trading protocols the dashboard's live tab shows. */
export const LIVE_ROWS = 24;

/** The multiple used when a snapshot offers no live protocol to learn from. Never this one. */
export const FALLBACK_MULTIPLE = 0.25;

/** What one category's multiple rests on: the value, the sample size, and where it came from. */
export interface CategoryMultiple {
  multiple: number;
  n: number;
  source: 'category' | 'global';
}

/** The calibration whole: the global median plus one entry per category that has live data. */
export interface Calibration {
  global_multiple: number;
  global_n: number;
  by_category: Record<string, CategoryMultiple>;
}

/** One farm step before it is flattened to a string: the deed, the cost, the time. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** A board.json row: the protocol, its rank, its score's audit trail, and its farm plan. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    multiple_source: 'category' | 'global';
    calibration_n: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's row: the board's row slimmed to what the page renders, plan included. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  multiple: number;
  multiple_source: 'category' | 'global';
  calibration_n: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  farm_steps: string[];
}

/** A trading protocol for the live tab: the market's own numbers, no model applied. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** The dashboard's dataset: the board, the live set, the calibration, and the notes that explain them. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  calibration: Calibration;
  methodology: string[];
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** The snapshot failed the shape check: the message names the first thing wrong. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** `value` when it is a finite number, `fallback` for anything else (null, NaN, a string). */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Four decimals, the precision every multiple and multiplier is stored at. */
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/**
 * Whole days from `listedAt` to `asOf`, never negative. Null when the listing date is missing
 * or unparseable: the model then scores the protocol at the unknown-age default instead of
 * guessing. Both dates are read as UTC midnights so the count never depends on a timezone.
 */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  const end = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const days = Math.floor((end - start) / DAY_MS);
  return days < 0 ? 0 : days;
}

/**
 * The middle of a list of numbers: the central value for an odd count, the mean of the two
 * central values for an even one. The input is never mutated. A median, not a mean, so one
 * runaway ratio cannot drag a category's price with it.
 */
export function median(values: number[]): number {
  const ordered = values.slice().sort((a, b) => a - b);
  const span = ordered.length - 1;
  const low = ordered[Math.floor(span / 2)]!;
  const high = ordered[Math.ceil(span / 2)]!;
  return (low + high) / 2;
}

/** The calibration bucket a protocol belongs to: its category, or Uncategorized when none is named. */
export function categoryKey(category: string | null): string {
  return category ?? 'Uncategorized';
}

/**
 * The ratios the calibration learns from, gathered in one pass: per-category buckets plus the
 * pooled list the global median comes from. A protocol votes only when it trades (a market
 * cap), is not an exchange, and carries positive TVL and market cap; its ratio must land
 * inside the model's band, or it is an outlier and sits this one out.
 */
function collectRatios(snapshot: Snapshot, model: ModelConstants): { perCategory: Map<string, number[]>; pooled: number[] } {
  const perCategory = new Map<string, number[]>();
  const pooled: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.category === 'CEX') continue;
    if (!(p.tvl_usd > 0) || !(p.mcap_usd > 0)) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio)) continue;
    if (ratio < model.calibration_ratio_min || ratio > model.calibration_ratio_max) continue;
    const bucket = perCategory.get(categoryKey(p.category));
    if (bucket === undefined) perCategory.set(categoryKey(p.category), [ratio]);
    else bucket.push(ratio);
    pooled.push(ratio);
  }
  return { perCategory, pooled };
}

/**
 * The snapshot's price of a dollar of TVL, learned per category. Each category with enough
 * live protocols gets its own median; thinner categories borrow the global median, and the
 * record says so, so the dashboard never presents a borrowed multiple as a measured one.
 * Every multiple is clamped into the model's band and rounded to four decimals. Pure: the
 * same snapshot always calibrates to the same table.
 */
export function calibrate(snapshot: Snapshot, model: ModelConstants = MODEL): Calibration {
  const { perCategory, pooled } = collectRatios(snapshot, model);
  const clamp = (n: number): number => round4(Math.min(model.calibration_multiple_max, Math.max(model.calibration_multiple_min, n)));
  const globalMultiple = pooled.length > 0 ? clamp(median(pooled)) : FALLBACK_MULTIPLE;
  const by_category: Record<string, CategoryMultiple> = {};
  for (const key of [...perCategory.keys()].sort()) {
    const bucket = perCategory.get(key)!;
    const measured = bucket.length >= model.calibration_min_samples;
    by_category[key] = measured
      ? { multiple: clamp(median(bucket)), n: bucket.length, source: 'category' }
      : { multiple: globalMultiple, n: bucket.length, source: 'global' };
  }
  return { global_multiple: globalMultiple, global_n: pooled.length, by_category };
}

/** The multiple a protocol is scored with: its category's entry, or the global median when its category has no live data at all. */
export function multipleFor(p: SnapshotProtocol, calibration: Calibration): CategoryMultiple {
  const entry = calibration.by_category[categoryKey(p.category)];
  if (entry !== undefined) return entry;
  return { multiple: calibration.global_multiple, n: 0, source: 'global' };
}

/** Growth's contribution: the clamped weekly change and the factor it implies. */
function growthFactor(change: number | null, model: ModelConstants): { pct: number; factor: number } {
  const pct = Math.min(model.growth_cap, Math.max(model.growth_floor, finite(change, 0)));
  return { pct, factor: 1 + (pct / 100) * model.growth_weight };
}

/** Maturity's contribution: the longer a protocol has run with no token, the closer to the full weight. */
function maturityFactor(age: number | null, model: ModelConstants): number {
  const days = age ?? model.unknown_age_days;
  const capped = Math.min(Math.max(days, 0), model.maturity_days);
  return model.maturity_floor + (capped / model.maturity_days) * model.maturity_range;
}

/** Everything one protocol's score is made of, kept for the board's audit trail. */
export interface Score {
  implied: number;
  multiple: number;
  multipleSource: 'category' | 'global';
  calibrationN: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  age: number | null;
}

/**
 * One protocol's implied value under the calibrated model. The arithmetic runs in one fixed
 * order — TVL times the multiple, times growth, times maturity, rounded, floored at one
 * dollar — and the dashboard's recompute runs the same order, so the page can show the
 * number is the board's number rather than ask for trust.
 */
export function impliedValue(protocol: SnapshotProtocol, asOf: string, model: ModelConstants, calibration: Calibration): Score {
  const age = ageDays(asOf, protocol.listed_at);
  const growth = growthFactor(protocol.change_7d, model);
  const maturity = maturityFactor(age, model);
  const mult = multipleFor(protocol, calibration);
  const implied = Math.max(1, Math.round(protocol.tvl_usd * mult.multiple * growth.factor * maturity));
  return {
    implied,
    multiple: mult.multiple,
    multipleSource: mult.source,
    calibrationN: mult.n,
    growthPct: growth.pct,
    growthMult: growth.factor,
    maturityMult: maturity,
    age,
  };
}

/** A name that ends in a release marker is a versioned pool of some other protocol, not a protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** No market cap, no CoinGecko id, no symbol: the index records no token for this protocol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Rankable means pre-token, not an exchange, and not a versioned pool wearing a release number. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** Slug order for ties: the same two rows always break the same way, in every run. */
function bySlugAsc(a: { slug: string }, b: { slug: string }): number {
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

/**
 * The early radar's intake: rankable protocols below the floor that the watchlist did not
 * already claim, richest first, capped. The watchlist is never displaced: a claimed slug
 * stays claimed even when a richer early protocol exists.
 */
function selectEarly(snapshot: Snapshot, claimed: ReadonlyMap<string, SnapshotProtocol>): SnapshotProtocol[] {
  return snapshot.protocols
    .filter((p) => !claimed.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || bySlugAsc(a, b))
    .slice(0, EARLY_ROWS);
}

/**
 * The ranked board: every watchlist slug the snapshot carries, plus the early intake, each
 * scored once and ordered by implied value, ties by slug. Ranks run 1..n with no gaps, and
 * the implied values never rise as the rank falls: the gate checks both, and so does the
 * dashboard's own sort.
 */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL, calibration: Calibration = calibrate(snapshot, model)): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const found = index.get(slug);
    if (found !== undefined) chosen.set(slug, found);
  }
  for (const p of selectEarly(snapshot, chosen)) chosen.set(p.slug, p);
  const scored = [...chosen.values()].map((p) => ({ protocol: p, score: impliedValue(p, snapshot.as_of, model, calibration) }));
  scored.sort((a, b) => b.score.implied - a.score.implied || bySlugAsc(a.protocol, b.protocol));
  return scored.map(({ protocol: p, score: s }, i) => ({
    rank: i + 1,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    mcap_usd: p.mcap_usd,
    listed_at: p.listed_at,
    gecko_id: p.gecko_id,
    symbol: p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      category_multiple: s.multiple,
      multiple_source: s.multipleSource,
      calibration_n: s.calibrationN,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(p, s.age).map(stepText),
  }));
}

/**
 * The farm playbook: one row per kind of protocol, matched by category keywords in order.
 * The first row whose keywords appear in the category wins, so a lending market is never
 * mistaken for a bridge. Each row gives the opening move (as a function of the protocol's
 * name, the capital tier, and the chain) and the weekly habit that keeps the position
 * counted. The default row catches every category the table does not name.
 */
interface PlaybookRow {
  keywords: string[];
  deposit: (name: string, capital: number, chain: string) => string;
  weekly: string;
}

const PLAYBOOK: PlaybookRow[] = [
  {
    keywords: ['lend', 'cdp', 'collateral'],
    deposit: (name, capital, chain) => `Lend $${capital} of USDC to ${name} on ${chain} and leave the supply in place.`,
    weekly: 'borrow a little against the supply and pay it back, so both sides of the market show activity',
  },
  {
    keywords: ['dex', 'yield', 'leveraged farm'],
    deposit: (name, capital, chain) => `Add $${capital} of liquidity to ${name}'s main pool on ${chain} and leave it working.`,
    weekly: 'add a little liquidity and pull it back out, so the pool sees fresh activity',
  },
  {
    keywords: ['bridge'],
    deposit: (name, capital, chain) => `Move $${capital} of USDC to ${chain} with ${name}, then put the bridged funds to use inside its app.`,
    weekly: 'send a small amount back to the chain you started from',
  },
  {
    keywords: ['staking', 'restak'],
    deposit: (name, capital, chain) => `Stake $${capital} of the chain's staking asset via ${name} on ${chain} and hold on to the receipt.`,
    weekly: 'look over the staking receipt and restake whatever rewards accrued',
  },
  {
    keywords: ['perpetual', 'derivative'],
    deposit: (name, capital, chain) => `Post $${capital} of USDC as margin on ${name} and open a single small hedge.`,
    weekly: 'open a small hedge and close it before the week ends',
  },
  {
    keywords: ['prediction'],
    deposit: (name, capital) => `Fund $${capital} and take one position in a ${name} market.`,
    weekly: 'close out one market position and open the next',
  },
  {
    keywords: ['curator', 'allocator'],
    deposit: (name, capital, chain) => `Put $${capital} into a ${name} vault on ${chain} and hold the shares.`,
    weekly: 'review the vault shares and top up a little if the strategy moved',
  },
  {
    keywords: ['stable'],
    deposit: (name, capital, chain) => `Mint or place $${capital} of the stable asset through ${name} on ${chain}.`,
    weekly: 'mint or redeem a small amount of the stable asset',
  },
  {
    keywords: ['rwa'],
    deposit: (name, capital, chain) => `Mint $${capital} of the protocol's yield-bearing asset on ${chain} and keep holding it.`,
    weekly: "read the yield asset's latest backing report and keep holding",
  },
  {
    keywords: ['insurance'],
    deposit: (name, capital, chain) => `Buy $${capital} of cover through ${name} on ${chain} and keep the policy active.`,
    weekly: "confirm the policy's coverage and expiry still stand",
  },
  {
    keywords: [],
    deposit: (name, capital, chain) => `Place $${capital} of USDC into ${name} on ${chain} and leave the position open.`,
    weekly: 'do one qualifying move — a deposit, a borrow, a swap or a vote',
  },
];

/** The playbook row a protocol's category matches: the first row with a keyword in it, else the default. */
function playbookFor(category: string | null): PlaybookRow {
  const c = (category ?? '').toLowerCase();
  for (const row of PLAYBOOK) {
    if (row.keywords.length > 0 && row.keywords.some((k) => c.includes(k))) return row;
  }
  return PLAYBOOK[PLAYBOOK.length - 1]!;
}

/** Capital tiers: the bigger the protocol, the larger the position that still reads as one farmer among many. */
const CAPITAL_TIERS: Array<[number, number]> = [
  [5_000_000_000, 250],
  [1_000_000_000, 150],
  [100_000_000, 100],
];

/** The position size for a protocol of this TVL: the richest tier it qualifies for, else $50. */
function capitalTier(tvl: number): number {
  for (const [floor, capital] of CAPITAL_TIERS) {
    if (tvl >= floor) return capital;
  }
  return 50;
}

/**
 * The hold window: younger protocols need longer to prove the activity is real, older ones
 * have already shown it. An unknown age takes the middle window rather than the longest.
 */
function holdWindow(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** A step flattened for the board: the deed, then its cost and time, inside the gate's length band. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/**
 * A protocol's six-step farm plan, composed from its own record. The steps walk the same
 * arc for every protocol — set up safely, take the position, keep it active, hold it,
 * claim safely, keep records — with the middle steps filled from the playbook row the
 * protocol's category matches. Costs and times are stated on every step, and the safety
 * steps (fresh wallet, revoke, claim only from official links) are the same for all.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const capital = capitalTier(p.tvl_usd);
  const hold = holdWindow(age);
  const play = playbookFor(p.category);
  const gas = capital >= 150 ? 8 : 4;
  return [
    {
      text: 'Start from a wallet that holds nothing but the funds for this farm, keep its recovery phrase somewhere offline, and remove the app\'s token approval once you are done.',
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: play.deposit(p.name, capital, chain),
      cost: `$${capital} of capital and about $${gas} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Once a week, ${play.weekly}.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Leave the position untouched for at least ${hold} days, so the activity lands in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: 'When you are ready to withdraw, reach the protocol\'s points or rewards page only through the link its official X or Discord account posts, and claim from nowhere else — not a DM, not a search ad.',
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: 'Keep a small log of the wallet, the dates and each transaction, so the position can be repeated or unwound later.',
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The trading protocols for the live tab: richest market caps first, exchanges excluded. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row slimmed for the dashboard, keeping the plan and the multiple it was scored with. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    multiple: row.model.category_multiple,
    multiple_source: row.model.multiple_source,
    calibration_n: row.model.calibration_n,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    farm_steps: row.farm_steps,
  };
}

/**
 * The methodology in the dashboard's own words, written here so the page states the model
 * the code actually ran: the formula's inputs, where the multiple comes from, and what the
 * fallback means. Shipped in data.js beside the numbers it describes.
 */
export function methodologyNotes(calibration: Calibration, model: ModelConstants): string[] {
  return [
    'One function scores every row from the snapshot figures alone. No protocol is named specially and no row is placed by hand: the ranking is what the arithmetic says it is.',
    `The multiple is measured, not assumed. For each category it is the median market-cap / TVL ratio of that category's live-token protocols in this snapshot, ${calibration.global_n} protocols in all. Ratios outside ${model.calibration_ratio_min}..${model.calibration_ratio_max} are trimmed as outliers and multiples are clamped to ${model.calibration_multiple_min}..${model.calibration_multiple_max}.`,
    `A category with fewer than ${model.calibration_min_samples} live protocols borrows the global median of ${round4(calibration.global_multiple)}x, and the table marks it borrowed: a thin category never looks more measured than it is.`,
    `Growth is the seven-day change clamped to ${model.growth_floor}..${model.growth_cap} per cent, weighted at ${model.growth_weight}. Maturity rises with the days since listing up to ${model.maturity_days} days; a protocol with no listing date is scored at ${model.unknown_age_days} days.`,
  ];
}

/** The board plus everything the dashboard renders, from one snapshot, in one pass. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const calibration = calibrate(snapshot, model);
  const board = buildBoard(snapshot, model, calibration);
  const live = liveRows(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    calibration,
    methodology: methodologyNotes(calibration, model),
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !watchlist.has(r.slug)).length,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** One protocol entry read out of untrusted JSON, with every field coerced or refused. */
function readProtocol(v: unknown, i: number): SnapshotProtocol {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
  const p = v as Record<string, unknown>;
  if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
    throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
  }
  const textOrNull = (x: unknown): string | null => (typeof x === 'string' ? x : null);
  const numberOrNull = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  return {
    slug: p.slug,
    name: p.name,
    category: textOrNull(p.category),
    chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
    tvl_usd: p.tvl_usd,
    change_7d: numberOrNull(p.change_7d),
    mcap_usd: numberOrNull(p.mcap_usd),
    listed_at: textOrNull(p.listed_at),
    gecko_id: textOrNull(p.gecko_id),
    symbol: textOrNull(p.symbol),
  };
}

/** The snapshot out of a file's text, refused unless it is exactly the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols: o.protocols.map((v, i) => readProtocol(v, i)),
    watchlist: o.watchlist as string[],
  };
}

/**
 * The board's own gate, run before anything is written: full watchlist coverage, ranks
 * 1..n, implied values never rising down the board, not every row equal, and every farm
 * plan inside the step-count and length bands. Null means the board is fit to ship.
 */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const present = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !present.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  }
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** data.js: the dashboard's dataset as one script tag's worth, so the page needs no fetch. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
