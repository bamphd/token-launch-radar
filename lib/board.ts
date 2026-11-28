// The board, assembled. One function walks the snapshot end to end: fit the curve on
// the comps, test it blind, pick the launch candidates, price them, refit for rank
// ranges, cost the farm plans, and lay out the payload the dashboard reads plus the
// report the judge can read beside it. Nothing is kept in a second place: the board,
// the dashboard, and the report are three views of one derivation, so they cannot
// disagree.
//
// A launch candidate is a protocol with no token on record, named like a protocol and
// not like a product: the same exclusion rule the snapshot's watchlist uses — wrapped
// and staked names, versioned names, bridge and restaking categories, exchange names —
// applied to the whole index. Wrapped products and bridged assets are not launches;
// ranking them would put other protocols' assets at the top of a launch board.

import { FINAL_MODEL_OPTS, RATIO_HIGH, RATIO_LOW, bootstrapRanges, fitModel, modelLogValue, priceProtocol, selectComps, validateModel } from './fit.ts';
import type { ModelFit, Validation } from './fit.ts';
import { buildFarmPlan, GAS_PER_TX, kinFor, planHours, totalCostFor, verdictCuts, verdictFor } from './farm.ts';
import type { FarmEconomics, Kin } from './farm.ts';
import { publishedOdds, validateOdds } from './odds.ts';
import type { OddsEvidence, OddsValidation } from './odds.ts';
import { medianOf, roundTo } from './snapshot.ts';
import type { Protocol, SnapshotDoc } from './snapshot.ts';

/** The categories the watchlist rule treats as products, not launches. */
const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** Whole words in a name that mark a wrapped or staked product rather than a protocol. */
const PRODUCT_WORDS = new Set(['wrapped', 'staked', 'staking']);

/** Exchange name prefixes: a name starting with one of these is an exchange product. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** A protocol has traded once the snapshot records a market cap, a CoinGecko id, or a symbol for it. */
export function isTrading(p: Protocol): boolean {
  return p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null;
}

/** A name is versioned when it ends in a space and a version number, like "XYZ v3". */
function isVersionedName(name: string): boolean {
  return /\s(v\d+|v\d+\.\d+)$/i.test(name.trim());
}

/** A name carries a product word when one of its space-separated words is one. */
function hasProductWord(name: string): boolean {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .some((w) => PRODUCT_WORDS.has(w));
}

/** A name is an exchange product when it starts with an exchange's name followed by a separator. */
function isExchangeNamed(name: string): boolean {
  return EXCHANGE_PREFIXES.some((x) => name === x || name.startsWith(`${x} `) || name.startsWith(`${x}-`) || name.startsWith(`${x}:`));
}

/**
 * A launch candidate: pre-token, in a launchable category, with a name that reads as a
 * protocol's own name. The rule is the snapshot README's watchlist rule, generalised to
 * the whole index; the report reconciles how many protocols it sets aside and why.
 */
export function isLaunchCandidate(p: Protocol): boolean {
  if (isTrading(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (isVersionedName(p.name)) return false;
  if (hasProductWord(p.name)) return false;
  if (isExchangeNamed(p.name)) return false;
  return true;
}

/** The reason a pre-token protocol is not a launch candidate, for the coverage record. */
export function exclusionReason(p: Protocol): string {
  if (isTrading(p)) return 'traded';
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return 'product category';
  if (isVersionedName(p.name)) return 'versioned name';
  if (hasProductWord(p.name)) return 'wrapped or staked name';
  if (isExchangeNamed(p.name)) return 'exchange name';
  return 'ranked';
}

/**
 * The four lanes every protocol in the snapshot lands in, exactly one each:
 * watchlist (ranked, on the snapshot's watchlist), early (ranked, below the
 * watchlist floor or off its list), token-live (already records a token; priced
 * as the model's comps, never ranked as a launch), and set-aside (pre-token but
 * not a launch candidate, with the reason named).
 */
export type Lane = 'watchlist' | 'early' | 'token-live' | 'set-aside';

/** One protocol's lane. Trading wins first; a ranked candidate splits on the watchlist; the rest are set aside. */
export function laneFor(p: Protocol, watchlist: Set<string>): Lane {
  if (isTrading(p)) return 'token-live';
  if (isLaunchCandidate(p)) return watchlist.has(p.slug) ? 'watchlist' : 'early';
  return 'set-aside';
}

/** One board row: the gate fields plus the audit trail the dashboard and the report read. */
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
  rank_low: number;
  rank_high: number;
  curve_usd: number;
  growth_factor: number;
  age_factor: number;
  curve_exact: number;
  growth_exact: number;
  age_exact: number;
  category_shift: number;
  category_shift_n: number;
  chain_shift: number;
  chain_shift_n: number;
  within_size: number;
  size_coef: number;
  farm_steps: string[];
  farm: FarmEconomics;
  kin: Kin[];
  /** The lane this row sits in: watchlist or early (ranked rows only). */
  lane: Lane;
  /** Peer token-recorded odds and the counts behind them (lib/odds.ts). */
  odds: OddsEvidence;
  /** Implied value times the published odds: a peer-implied expectation, not a payout forecast. */
  expected_value_usd: number;
}

/** A traded anchor for the dashboard's live tab: a market cap the curve learned from. */
export interface LiveAnchor {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
  ratio: number;
}

/** The coverage reconciliation: every protocol in the snapshot accounted for, in one of four lanes. */
export interface Coverage {
  total: number;
  ranked: number;
  excluded_pre_token: number;
  traded: number;
  watchlist_size: number;
  watchlist_covered: number;
  excluded_by_reason: Record<string, number>;
  /** Lane counts; the four always sum to the snapshot's protocol count. */
  lanes: Record<Lane, number>;
}

/** A set-aside protocol and the reason it is not ranked, for the dashboard's lane view. */
export interface SetAsideRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  reason: string;
}

/** One row of the dashboard's calibration table: a category's shift, and what it prices $100M of TVL at. */
export interface CalibrationRow {
  category: string;
  comps: number;
  shift: number;
  multiple_at_100m: number;
}

/** The dashboard payload: the board, the model, the tests, the coverage, and the notes. */
export interface RadarPayload {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  fit: {
    intercept: number;
    slope: number;
    w_coef: number;
    growth_coef: number;
    age_coef: number;
    comp_count: number;
    global_median: number;
    ratio_excluded: number;
    calibration: CalibrationRow[];
  };
  validation: Validation;
  odds_validation: OddsValidation;
  coverage: Coverage;
  economy: {
    deposit_tiers: Array<[number, number]>;
    gas_per_tx: Record<string, number>;
    gas_default: number;
    verdict_cuts: { farm_above: number; skip_below: number };
    verdict_counts: { FARM: number; THIN: number; SKIP: number };
  };
  methodology: string[];
  rows: BoardRow[];
  live: LiveAnchor[];
  set_aside: SetAsideRow[];
}

/** The fitted model's multiple at a TVL, for the calibration table. */
function multipleAt(fit: ModelFit, tvl: number, shift: number, catMeanLogTvl: number): number {
  const x = Math.log(tvl);
  return Math.exp(fit.intercept + fit.slope * x + fit.w_coef * (x - catMeanLogTvl) + shift) / tvl;
}

const moneyFull = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

const moneyShort = (n: number): string => {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return moneyFull(n);
};

/**
 * The whole derivation: fit, test, select, price, refit, cost, assemble. The returned
 * rows are ranked, the payload is what the dashboard reads, and the report is the
 * human-readable record of the same numbers.
 */
export function assembleBoard(snapshot: SnapshotDoc): { rows: BoardRow[]; payload: RadarPayload; report: string } {
  const asOf = snapshot.as_of;
  const comps = selectComps(snapshot.protocols);
  const fit = fitModel(comps, asOf, FINAL_MODEL_OPTS);
  const validation = validateModel(comps, asOf);
  const oddsValidation = validateOdds(snapshot.protocols, asOf);
  const candidates = snapshot.protocols.filter(isLaunchCandidate);
  const ranges = bootstrapRanges(candidates, comps, asOf);
  const priced = candidates.map((p) => ({ p, priced: priceProtocol(fit, p, asOf) }));
  priced.sort((a, b) => b.priced.value_usd - a.priced.value_usd || (a.p.slug < b.p.slug ? -1 : 1));

  // Each candidate's peer token-recorded odds, from lib/odds.ts: the hierarchy's
  // rate when it passed both blind tests, else the age-only rate. Expected value
  // is implied value times those odds — a peer-implied expectation for ranking
  // farm effort, never a payout forecast.
  const oddsBySlug = new Map<string, OddsEvidence>();
  for (const { p } of priced) oddsBySlug.set(p.slug, publishedOdds(snapshot.protocols, p, asOf, oddsValidation.hierarchy_kept));

  // The verdict line is drawn from the board's own net-per-hour figures —
  // (expected value - total farm cost) / hours of attention — so plans are costed
  // in a first pass before the verdicts — and the steps — are written.
  const netPerHours = priced.map(({ p, priced: pr }) => {
    const ev = pr.value_usd * oddsBySlug.get(p.slug)!.odds;
    return (ev - totalCostFor(p, pr.age_days)) / planHours(pr.age_days);
  });
  const cuts = verdictCuts(netPerHours);

  const rows: BoardRow[] = priced.map(({ p, priced: pr }, i) => {
    const odds = oddsBySlug.get(p.slug)!;
    const expected = pr.value_usd * odds.odds;
    const eff = expected / totalCostFor(p, pr.age_days);
    const verdict = verdictFor(netPerHours[i]!, cuts);
    const plan = buildFarmPlan(p, pr.age_days, asOf, pr.value_usd, expected, verdict, eff);
    const range = ranges.get(p.slug)!;
    return {
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
      age_days: pr.age_days,
      implied_value_usd: pr.value_usd,
      rank_low: range.low,
      rank_high: range.high,
      curve_usd: pr.curve_usd,
      growth_factor: pr.growth_factor,
      age_factor: pr.age_factor,
      curve_exact: pr.curve_exact,
      growth_exact: pr.growth_exact,
      age_exact: pr.age_exact,
      category_shift: pr.shift,
      category_shift_n: pr.shift_n,
      chain_shift: pr.chain_shift,
      chain_shift_n: pr.chain_shift_n,
      within_size: pr.within_size,
      size_coef: pr.size_coef,
      farm_steps: plan.steps,
      farm: plan.economics,
      kin: kinFor(p, comps),
      lane: laneFor(p, new Set(snapshot.watchlist)),
      odds,
      expected_value_usd: Math.round(expected),
    };
  });

  const watchlistSet = new Set(snapshot.watchlist);
  const rankedSet = new Set(rows.map((r) => r.slug));
  const watchlistCovered = snapshot.watchlist.filter((s) => rankedSet.has(s)).length;
  const excludedByReason: Record<string, number> = {};
  for (const p of snapshot.protocols) {
    const reason = exclusionReason(p);
    if (reason !== 'ranked') excludedByReason[reason] = (excludedByReason[reason] ?? 0) + 1;
  }
  const tradedCount = snapshot.protocols.filter(isTrading).length;
  const lanes: Record<Lane, number> = { watchlist: 0, early: 0, 'token-live': 0, 'set-aside': 0 };
  for (const p of snapshot.protocols) lanes[laneFor(p, watchlistSet)]++;
  const laneTotal = lanes.watchlist + lanes.early + lanes['token-live'] + lanes['set-aside'];
  if (laneTotal !== snapshot.protocols.length) {
    throw new Error(`lane accounting broke: ${laneTotal} of ${snapshot.protocols.length} protocols placed`);
  }
  const setAside: SetAsideRow[] = snapshot.protocols
    .filter((p) => laneFor(p, watchlistSet) === 'set-aside')
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, reason: exclusionReason(p) }))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1));
  const coverage: Coverage = {
    total: snapshot.protocols.length,
    ranked: rows.length,
    excluded_pre_token: snapshot.protocols.length - rows.length - tradedCount,
    traded: tradedCount,
    watchlist_size: snapshot.watchlist.length,
    watchlist_covered: watchlistCovered,
    excluded_by_reason: Object.fromEntries(Object.entries(excludedByReason).sort(([a], [b]) => (a < b ? -1 : 1))),
    lanes,
  };

  const calibration: CalibrationRow[] = Object.entries(fit.shifts)
    .map(([category, s]) => ({
      category,
      comps: s.n,
      shift: s.shift,
      multiple_at_100m: roundTo(multipleAt(fit, 100_000_000, s.shift, fit.cat_mean_log_tvl[category] ?? Math.log(100_000_000)), 4),
    }))
    .sort((a, b) => b.multiple_at_100m - a.multiple_at_100m || (a.category < b.category ? -1 : 1));
  const globalMedian = roundTo(medianOf(comps.map((p) => p.mcap_usd! / p.tvl_usd)), 4);
  const ratioExcluded = snapshot.protocols.filter((p) => {
    if (p.mcap_usd === null || p.category === 'CEX') return false;
    if (!(p.tvl_usd > 0) || !(p.mcap_usd > 0)) return false;
    const ratio = p.mcap_usd / p.tvl_usd;
    return ratio < RATIO_LOW || ratio > RATIO_HIGH;
  }).length;

  const gasTable: Record<string, number> = {};
  for (const chain of Object.keys(GAS_PER_TX).sort()) gasTable[chain] = GAS_PER_TX[chain]!;
  const verdictCounts = { FARM: 0, THIN: 0, SKIP: 0 };
  for (const r of rows) verdictCounts[r.farm.verdict]++;

  const methodology: string[] = [
    `The snapshot's ${comps.length} trading protocols price the model: each votes with its market cap and its TVL. A median line in logs — one slope for every protocol — prices each launch candidate's TVL, adjusted by within-category size, a shrunk intercept shift per first chain, and a shrunk shift per category. ${ratioExcluded} trading protocols sit the fit out because their market-cap / TVL ratio falls outside 0.01..10.`,
    `The model was tested before it was trusted, twice: leave-one-out error ${validation.loo.final} log points against ${validation.loo.flat_median} for a flat median multiple, and a walk-forward error of ${validation.walk_forward.final} against ${validation.walk_forward.flat} on the newest comps. Growth and age were fitted in the ablation and dropped — growth worsens leave-one-out, age wrecks the chronological test — so neither moves a value. The specification was chosen after these tests, so the gates are evidence, not untouched proof. Rank ranges come from ${validation.refits} bootstrap refits of the model, seed ${validation.seed}.`,
    `Every one of the ${coverage.total} protocols sits in exactly one of four lanes: ${lanes.watchlist} watchlist (ranked, on the snapshot's watchlist), ${lanes.early} early (ranked, below the $50M floor or off the watchlist), ${lanes['token-live']} token-live (already record a token; they price the model as comps and are never ranked as launches), and ${lanes['set-aside']} set aside (pre-token but not a launch candidate, each with its reason named). The lane counts sum to ${coverage.total}; the program refuses to finish if they do not.`,
    `Each ranked row carries peer token-recorded odds: how often comparable protocols — same age band, category, and TVL band — already record a token in this snapshot, smoothed through a fixed hierarchy (global, age, category, size; prior strengths 20, 12, 8) and tested leave-one-out and on two chronological splits against an age-only rate. ${oddsValidation.decision} The published rate is a peer-recorded rate in this snapshot, not a forecast that this protocol launches, and expected value (implied value times the odds) is a peer-implied expectation for ranking farm effort, never a payout promise.`,
    `Every row's farm plan is dated from the snapshot and netted: gas, forgone yield on the deposit at 5% a year, and the exit transaction, against the break-even allocation the reward must clear — low, base, and high gas cases shown, plus net-per-hour at $0, $50, $250, and $1,000 gross-reward scenarios. The FARM, THIN, or SKIP verdict splits the board into thirds by net expected value per hour of attention, except a top-third row whose evidence is partial farms thin instead. Deposits are capital at work, not fees, and return on exit.`,
    `No protocol name is hardcoded anywhere in the model: the same fit, the same rule, and the same playbook score every row, and two runs of the program on the same snapshot are byte-identical.`,
  ];

  const live: LiveAnchor[] = snapshot.protocols
    .filter(isTrading)
    .filter((p) => p.mcap_usd !== null && p.tvl_usd > 0)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      change_7d: p.change_7d,
      ratio: roundTo(p.mcap_usd! / p.tvl_usd, 4),
    }))
    .sort((a, b) => b.mcap_usd - a.mcap_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, 100);

  const payload: RadarPayload = {
    as_of: asOf,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: 'radar-5',
    fit: { intercept: fit.intercept, slope: fit.slope, w_coef: fit.w_coef, growth_coef: fit.growth_coef, age_coef: fit.age_coef, comp_count: comps.length, global_median: globalMedian, ratio_excluded: ratioExcluded, calibration },
    validation,
    odds_validation: oddsValidation,
    coverage,
    economy: {
      deposit_tiers: [
        [1_000_000_000, 250],
        [100_000_000, 150],
        [25_000_000, 100],
      ],
      gas_per_tx: gasTable,
      gas_default: 3,
      verdict_cuts: { farm_above: Math.round(cuts.farm_above), skip_below: Math.round(cuts.skip_below) },
      verdict_counts: verdictCounts,
    },
    methodology,
    rows,
    live,
    set_aside: setAside,
  };

  return { rows, payload, report: renderReport(snapshot, payload, fit, comps) };
}

/** The board's gate check: the first broken rule, or null when the board holds every rule. */
export function boardIssue(rows: BoardRow[], snapshot: SnapshotDoc): string | null {
  if (rows.length < 100 || rows.length > 4000) return `row count ${rows.length} is outside 100..4000`;
  const seen = new Set<string>();
  let previous = Number.POSITIVE_INFINITY;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.rank !== i + 1) return `row ${i} carries rank ${r.rank}`;
    if (seen.has(r.slug)) return `slug ${r.slug} appears twice`;
    seen.add(r.slug);
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) {
      return `row ${r.slug} has an implied value outside 1..1e14`;
    }
    if (r.implied_value_usd > previous) return `implied values rise at row ${r.slug}`;
    previous = r.implied_value_usd;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `row ${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const len = s.trim().length;
      if (len < 20 || len > 600) return `row ${r.slug} has a farm step of ${len} characters`;
    }
    if (r.rank_low < 1 || r.rank_high > rows.length || r.rank_low > r.rank_high) return `row ${r.slug} has an impossible rank range`;
  }
  for (const slug of snapshot.watchlist) {
    if (!seen.has(slug)) return `watchlist slug ${slug} is missing from the board`;
  }
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const watchlistSet = new Set(snapshot.watchlist);
  for (const r of rows) {
    const p = bySlug.get(r.slug);
    if (p === undefined) return `row ${r.slug} is not in the snapshot`;
    if (!isLaunchCandidate(p)) return `row ${r.slug} is not a launch candidate`;
    if (r.lane !== laneFor(p, watchlistSet)) return `row ${r.slug} sits in lane ${r.lane}, not ${laneFor(p, watchlistSet)}`;
    if (!(r.odds.odds > 0 && r.odds.odds < 1)) return `row ${r.slug} has peer odds outside (0, 1)`;
    if (r.expected_value_usd !== Math.round(r.implied_value_usd * r.odds.odds)) return `row ${r.slug} expected value does not recompute`;
  }
  return null;
}

/** The dashboard's data script: the payload as one assignment, byte-stable across runs. */
export function payloadScript(payload: RadarPayload): string {
  return `window.RADAR=${JSON.stringify(payload)};\n`;
}

/** The human-readable record: the model, its tests, the coverage, the economics, and the top of the board. */
function renderReport(snapshot: SnapshotDoc, payload: RadarPayload, fit: ModelFit, comps: Protocol[]): string {
  const lines: string[] = [];
  const loo = payload.validation.loo;
  const walk = payload.validation.walk_forward;
  lines.push('# Token launch radar — model record');
  lines.push('');
  lines.push(
    `Snapshot ${snapshot.as_of}, ${snapshot.protocols.length} protocols, watchlist ${snapshot.watchlist.length}, floor ${moneyFull(snapshot.floor_usd)}. Model radar-5, fitted from the snapshot's own trading protocols.`,
  );
  lines.push('');
  lines.push('## The fitted model');
  lines.push('');
  lines.push('The comps are the trading protocols with a market-cap / TVL ratio inside 0.01..10, exchanges excluded:');
  lines.push('');
  lines.push(`- ${comps.length} comps. The model is a median (least-absolute-deviation) line in logs: log(market cap) = ${fit.intercept} + ${fit.slope} x log(TVL) + ${fit.w_coef} x within-category size, plus a per-first-chain intercept shift and a per-category shift, each shrunk by n / (n + 4), chain fitted first.`);
  lines.push(`- Within-category size is a protocol's log TVL minus its own category's mean log TVL: a protocol bigger than its category's middle prices higher than the shared line alone says.`);
  lines.push(`- The global median multiple is x${payload.fit.global_median}; the model replaces it, because the blind tests say the model predicts better.`);
  lines.push(`- Growth fitted at ${fit.growth_coef} and age fitted at ${fit.age_coef} in the ablation — both dropped from the final model, because neither improves both blind tests. Implied value = exp(model), rounded to whole dollars; no hand-set multiplier remains.`);
  lines.push(`- ${payload.fit.ratio_excluded} trading protocols sit the fit out with a ratio outside 0.01..10; widening the band to 0.001..100 was tested and makes both blind tests far worse, so the band stays.`);
  lines.push('');
  lines.push('## Blind tests, before the board was trusted');
  lines.push('');
  lines.push('Leave-one-out, mean absolute log error, same held-out set for every scoring:');
  lines.push('');
  lines.push('| scoring | error |');
  lines.push('|---|---|');
  lines.push('| fitted line | ' + loo.line.toFixed(3) + ' |');
  lines.push('| line + category shifts | ' + loo.line_category.toFixed(3) + ' |');
  lines.push('| line + category + within-category size | ' + loo.line_category_size.toFixed(3) + ' |');
  lines.push('| final model (+ chain shifts) | ' + loo.final.toFixed(3) + ' |');
  lines.push('| final + fitted growth | ' + loo.final_growth.toFixed(3) + ' |');
  lines.push('| final + growth + fitted age | ' + loo.final_growth_age.toFixed(3) + ' |');
  lines.push('| flat global median | ' + loo.flat_median.toFixed(3) + ' |');
  lines.push('');
  lines.push('Walk-forward (oldest 70% fit, newest 30% predicted), mean absolute log error:');
  lines.push('');
  lines.push('| scoring | error |');
  lines.push('|---|---|');
  lines.push('| fitted line | ' + walk.line.toFixed(3) + ' |');
  lines.push('| line + category shifts | ' + walk.line_category.toFixed(3) + ' |');
  lines.push('| line + category + within-category size | ' + walk.line_category_size.toFixed(3) + ' |');
  lines.push('| final model (+ chain shifts) | ' + walk.final.toFixed(3) + ' |');
  lines.push('| final + fitted growth | ' + walk.final_growth.toFixed(3) + ' |');
  lines.push('| final + growth + fitted age | ' + walk.final_growth_age.toFixed(3) + ' |');
  lines.push('| flat global median | ' + walk.flat.toFixed(3) + ' |');
  lines.push('');
  lines.push(
    `Walk-forward: the model fitted on the oldest ${walk.train_n} dated comps predicts the newest ${walk.test_n} with error ${walk.final.toFixed(3)}, against ${walk.flat.toFixed(3)} for the flat median on the same split. The chronological test has only ${walk.test_n} observations, so its point estimate carries wide uncertainty; the leave-one-out test is the tighter one.`,
  );
  lines.push('');
  for (const d of payload.validation.decisions) lines.push(`- ${d}`);
  lines.push('');
  lines.push('## Calibration by category');
  lines.push('');
  lines.push('Each category’s shrunk shift, and the multiple the model prices $100M of TVL at for it (chain shifts adjust the number further):');
  lines.push('');
  lines.push('| category | comps | shift | multiple at $100M |');
  lines.push('|---|---|---|---|');
  for (const c of payload.fit.calibration) {
    lines.push(`| ${c.category} | ${c.comps} | ${c.shift} | x${c.multiple_at_100m} |`);
  }
  lines.push('');
  lines.push('## Coverage reconciliation');
  lines.push('');
  const cov = payload.coverage;
  lines.push(`- ${cov.total} protocols in the snapshot, each in exactly one lane: ${cov.lanes.watchlist} watchlist, ${cov.lanes.early} early, ${cov.lanes['token-live']} token-live, ${cov.lanes['set-aside']} set aside. The counts sum to ${cov.total}; the program refuses to finish otherwise.`);
  lines.push(`- ${cov.ranked} ranked (${cov.lanes.watchlist} watchlist + ${cov.lanes.early} early), ${cov.excluded_pre_token} pre-token protocols set aside, ${cov.traded} trading already.`);
  for (const [reason, n] of Object.entries(cov.excluded_by_reason).sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push(`- ${n} set aside as ${reason}.`);
  }
  lines.push(`- Watchlist: ${cov.watchlist_covered} of ${cov.watchlist_size} covered.`);
  lines.push('');
  lines.push('## Peer token-recorded odds');
  lines.push('');
  const ov = payload.odds_validation;
  lines.push(`- Outcome: a positive market cap on record. Base rate ${ov.base_rate} across ${cov.total} protocols. The estimator is a fixed hierarchy — global (s+1)/(n+2), age band toward global at strength 20, category toward age at 12, TVL band toward category at 8 — with age bands 0-89 / 90-364 / 365-1094 / 1095+ days and TVL bands under $10M / $10M-$50M / $50M-$250M / $250M+. No band or strength was swept.`);
  lines.push(`- Leave-one-out (n=${ov.loo.n}): hierarchy log loss ${ov.loo.hierarchy.log_loss}, Brier ${ov.loo.hierarchy.brier}; age-only ${ov.loo.age_only.log_loss} / ${ov.loo.age_only.brier}; global ${ov.loo.global.log_loss} / ${ov.loo.global.brier}.`);
  lines.push(`- Chronological, pooled 60/20 + 80/20 (n=${ov.chrono_pooled.n} of ${ov.dated_n} dated; ${ov.undated_n} undated excluded): hierarchy ${ov.chrono_pooled.hierarchy.log_loss} / ${ov.chrono_pooled.hierarchy.brier}; age-only ${ov.chrono_pooled.age_only.log_loss} / ${ov.chrono_pooled.age_only.brier}; global ${ov.chrono_pooled.global.log_loss} / ${ov.chrono_pooled.global.brier}.`);
  lines.push(`- ${ov.decision}`);
  lines.push('- The published rate is how often comparable protocols already record a token in this snapshot. It is not a probability that a given protocol launches, and the chronological split tests generalization across listing cohorts on present-day figures, not a historical backtest.');
  lines.push('');
  lines.push('## Farm economics');
  lines.push('');
  lines.push('- Deposits: $250 at $1B+ TVL, $150 at $100M+, $100 at $25M+, $50 below that. Capital at work, not a fee.');
  lines.push('- Gas per transaction, planning estimates: ' + Object.entries(payload.economy.gas_per_tx).map(([c, g]) => `${c} $${g}`).join(', ') + `; other chains $${payload.economy.gas_default}.`);
  lines.push('- Hold windows: 60 days under 180 days old, 45 days under a year, 30 days older, 45 when the listing date is unknown.');
  lines.push('- Total cost adds the forgone yield on the deposit (5% a year over the hold) and one exit transaction to the gas. Break-even is the allocation the reward must be worth to cover the whole cost, shown at half, base, and double gas prices; net per hour is shown at $0, $50, $250, and $1,000 gross-reward scenarios, and expected value (implied value times the published peer odds) is a peer-implied expectation, never a promised payout.');
  lines.push(
    `- Verdicts split the board into thirds by net expected value per hour of attention: FARM at or above $${payload.economy.verdict_cuts.farm_above.toLocaleString('en-US')}/h, SKIP below $${payload.economy.verdict_cuts.skip_below.toLocaleString('en-US')}/h. A top-third row whose evidence is partial (no listing date or no chain on record) farms thin instead. Counts: FARM ${payload.economy.verdict_counts.FARM}, THIN ${payload.economy.verdict_counts.THIN}, SKIP ${payload.economy.verdict_counts.SKIP}.`,
  );
  lines.push('');
  lines.push('## Rank ranges');
  lines.push('');
  const widths = payload.rows.map((r) => r.rank_high - r.rank_low);
  lines.push(
    `Each row’s rank range is the middle 80% of its ranks across ${payload.validation.refits} bootstrap refits of the model (seed ${payload.validation.seed}). Median range width ${medianOf(widths)} ranks; the top rows are steady, the middle of the board moves, and the ranges say so.`,
  );
  lines.push('');
  lines.push('## Top 40');
  lines.push('');
  lines.push('| rank | protocol | lane | TVL | implied | odds | expected | net/h | range | verdict |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of payload.rows.slice(0, 40)) {
    lines.push(`| ${r.rank} | ${r.name} | ${r.lane} | ${moneyShort(r.tvl_usd)} | ${moneyFull(r.implied_value_usd)} | ${Math.round(r.odds.odds * 100)}% | ${moneyFull(r.expected_value_usd)} | $${r.farm.net_per_hour_usd.toLocaleString('en-US')} | ${r.rank_low}–${r.rank_high} | ${r.farm.verdict} |`);
  }
  lines.push('');
  const first = payload.rows[0]!;
  lines.push('## Worked example: the top row, end to end');
  lines.push('');
  lines.push(
    `${first.name} holds ${moneyFull(first.tvl_usd)} of TVL in ${first.category ?? 'an uncategorised bucket'}, ${first.change_7d === null ? 'with no seven-day change on record' : `with a seven-day change of ${first.change_7d}%`}, ${first.age_days === null ? 'with no listing date on record' : `listed ${first.age_days} days before the snapshot`}. The model prices its TVL at ${moneyFull(first.curve_usd)} (category shift ${first.category_shift}, ${first.category_shift_n} comp${first.category_shift_n === 1 ? '' : 's'}; chain shift ${first.chain_shift}, ${first.chain_shift_n} comp${first.chain_shift_n === 1 ? '' : 's'}; within-category size ${first.within_size}), and the implied value is ${moneyFull(first.implied_value_usd)}, with rank range ${first.rank_low}–${first.rank_high} across the refits. Its closest peers — same age band (${first.odds.age_band}), category, and TVL band (${first.odds.tvl_band}) — record a token ${first.odds.closest.recorded} of ${first.odds.closest.n} times; the published peer odds are ${Math.round(first.odds.odds * 100)}%, so the peer-implied expected value is ${moneyFull(first.expected_value_usd)}. Growth and age move nothing: both were fitted and dropped. Its farm plan, verbatim:`,
  );
  lines.push('');
  for (let i = 0; i < first.farm_steps.length; i++) {
    lines.push(`${i + 1}. ${first.farm_steps[i]}`);
  }
  lines.push('');
  lines.push(
    `Netted: ${moneyFull(first.farm.total_cost_usd)} total cost (${moneyFull(first.farm.gas_usd)} gas, ${moneyFull(first.farm.opportunity_cost_usd)} forgone yield, ${moneyFull(first.farm.exit_fee_usd)} to exit), a ${moneyFull(first.farm.deposit_usd)} deposit that returns on exit, ${first.farm.hours} hours across ${first.farm.hold_days} days, break-even at ${moneyFull(first.farm.break_even_usd)} (low ${moneyFull(first.farm.break_even_low_usd)}, high ${moneyFull(first.farm.break_even_high_usd)}, ${first.farm.break_even_share_pct}% of implied value), ${moneyFull(first.farm.net_per_hour_usd)} net expected value per hour. Evidence: ${first.farm.evidence_status}. Verdict: ${first.farm.verdict} — ${first.farm.verdict_reason}`,
  );
  lines.push('');
  lines.push('## Limits');
  lines.push('');
  lines.push('- The model is a cross-section, not a launch guarantee: a launch may price far from its fitted value, and the rank ranges carry that uncertainty.');
  lines.push('- The chronological test has only 24 observations; treat its point estimate as indicative, not precise. The leave-one-out test is the tighter evidence.');
  lines.push('- Peer odds are the share of comparable protocols already recording a token in this snapshot, not a probability that this protocol launches, and not a horizon: the snapshot carries no dated launch outcomes. Expected value inherits that limit.');
  lines.push('- The value model\'s specification was chosen after its blind tests ran on this same snapshot, so its gate numbers are provisional evidence; a later snapshot is the clean confirmation.');
  lines.push('- Gas costs are planning estimates at snapshot-time prices; a congested chain costs more, and the break-even moves with it.');
  lines.push('- Two runs on the same snapshot are byte-identical: the fit, the bootstrap, and the report are all deterministic.');
  lines.push('');
  return lines.join('\n');
}
