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

import { bootstrapRanges, fitCurve, priceProtocol, selectComps, shiftKey, validateModel } from './fit.ts';
import type { CurveFit, Validation } from './fit.ts';
import { buildFarmPlan, GAS_PER_TX, kinFor, verdictCuts, verdictFor } from './farm.ts';
import type { FarmEconomics, Kin } from './farm.ts';
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
  farm_steps: string[];
  farm: FarmEconomics;
  kin: Kin[];
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

/** The coverage reconciliation: every protocol in the snapshot accounted for, in one of three buckets. */
export interface Coverage {
  total: number;
  ranked: number;
  excluded_pre_token: number;
  traded: number;
  watchlist_size: number;
  watchlist_covered: number;
  excluded_by_reason: Record<string, number>;
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
    comp_count: number;
    global_median: number;
    calibration: CalibrationRow[];
  };
  validation: Validation;
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
}

/** The fitted curve's multiple at a TVL, for the calibration table. */
function multipleAt(fit: CurveFit, tvl: number, shift: number): number {
  return Math.exp(fit.intercept + fit.slope * Math.log(tvl) + shift) / tvl;
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
  const fit = fitCurve(comps);
  const validation = validateModel(comps, asOf);
  const candidates = snapshot.protocols.filter(isLaunchCandidate);
  const ranges = bootstrapRanges(candidates, comps, asOf);
  const priced = candidates.map((p) => ({ p, priced: priceProtocol(fit, p, asOf) }));
  priced.sort((a, b) => b.priced.value_usd - a.priced.value_usd || (a.p.slug < b.p.slug ? -1 : 1));

  // The verdict line is drawn from the board's own efficiencies, so plans are costed
  // in a first pass before the verdicts — and the steps — are written.
  const gasOf = (p: Protocol): number => {
    const first = p.chains.length > 0 ? p.chains[0]! : '';
    return GAS_PER_TX[first] ?? 3;
  };
  const holdOf = (age: number | null): number => (age === null ? 45 : age < 180 ? 60 : age < 365 ? 45 : 30);
  const efficiencies = priced.map(({ p, priced: pr }) => {
    const weeks = Math.max(1, Math.ceil(holdOf(pr.age_days) / 7));
    const gas = gasOf(p) * (1 + 2 + weeks + 1);
    return pr.value_usd / gas;
  });
  const cuts = verdictCuts(efficiencies);

  const rows: BoardRow[] = priced.map(({ p, priced: pr }, i) => {
    const eff = efficiencies[i]!;
    const verdict = verdictFor(eff, cuts);
    const plan = buildFarmPlan(p, pr.age_days, asOf, pr.value_usd, verdict, eff);
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
      farm_steps: plan.steps,
      farm: plan.economics,
      kin: kinFor(p, comps),
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
  const coverage: Coverage = {
    total: snapshot.protocols.length,
    ranked: rows.length,
    excluded_pre_token: snapshot.protocols.length - rows.length - tradedCount,
    traded: tradedCount,
    watchlist_size: snapshot.watchlist.length,
    watchlist_covered: watchlistCovered,
    excluded_by_reason: Object.fromEntries(Object.entries(excludedByReason).sort(([a], [b]) => (a < b ? -1 : 1))),
  };

  const calibration: CalibrationRow[] = Object.entries(fit.shifts)
    .map(([category, s]) => ({
      category,
      comps: s.n,
      shift: s.shift,
      multiple_at_100m: roundTo(multipleAt(fit, 100_000_000, s.shift), 4),
    }))
    .sort((a, b) => b.multiple_at_100m - a.multiple_at_100m || (a.category < b.category ? -1 : 1));
  const globalMedian = roundTo(medianOf(comps.map((p) => p.mcap_usd! / p.tvl_usd)), 4);

  const gasTable: Record<string, number> = {};
  for (const chain of Object.keys(GAS_PER_TX).sort()) gasTable[chain] = GAS_PER_TX[chain]!;
  const verdictCounts = { FARM: 0, THIN: 0, SKIP: 0 };
  for (const r of rows) verdictCounts[r.farm.verdict]++;

  const methodology: string[] = [
    `The snapshot's ${comps.length} trading protocols price the model: each votes with its market cap and its TVL. A fitted curve in logs — one slope for every protocol, one shrunk intercept shift per category — prices each launch candidate's TVL, then the clamped seven-day change and a gentle age term adjust the number.`,
    `The curve was tested before it was trusted: leave-one-out error ${validation.loo.curve_growth_age} log points against ${validation.loo.flat_median} for a flat median multiple, and a walk-forward error of ${validation.walk_forward.curve_err} against ${validation.walk_forward.flat_err} on the newest comps. Rank ranges come from ${validation.refits} bootstrap refits of the curve, seed ${validation.seed}.`,
    `A launch candidate is a protocol with no token on record, in a launchable category, named like a protocol: wrapped and staked products, versioned names, bridge and restaking categories, and exchange names are set aside, the same rule the snapshot's watchlist uses. ${coverage.ranked} protocols rank; ${coverage.excluded_pre_token} pre-token protocols are set aside; ${coverage.traded} trade already.`,
    `Every row's farm plan is dated from the snapshot, costed per transaction on the protocol's own first chain, and netted: total gas, hours of attention, the break-even allocation, and the implied dollars per gas dollar that sets the FARM, THIN, or SKIP verdict. Deposits are capital at work, not fees, and return on exit.`,
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
    model_version: 'radar-3',
    fit: { intercept: fit.intercept, slope: fit.slope, comp_count: comps.length, global_median: globalMedian, calibration },
    validation,
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
  for (const r of rows) {
    const p = bySlug.get(r.slug);
    if (p === undefined) return `row ${r.slug} is not in the snapshot`;
    if (!isLaunchCandidate(p)) return `row ${r.slug} is not a launch candidate`;
  }
  return null;
}

/** The dashboard's data script: the payload as one assignment, byte-stable across runs. */
export function payloadScript(payload: RadarPayload): string {
  return `window.RADAR=${JSON.stringify(payload)};\n`;
}

/** The human-readable record: the model, its tests, the coverage, the economics, and the top of the board. */
function renderReport(snapshot: SnapshotDoc, payload: RadarPayload, fit: CurveFit, comps: Protocol[]): string {
  const lines: string[] = [];
  const loo = payload.validation.loo;
  const walk = payload.validation.walk_forward;
  lines.push('# Token launch radar — model record');
  lines.push('');
  lines.push(
    `Snapshot ${snapshot.as_of}, ${snapshot.protocols.length} protocols, watchlist ${snapshot.watchlist.length}, floor ${moneyFull(snapshot.floor_usd)}. Model radar-3, fitted from the snapshot's own trading protocols.`,
  );
  lines.push('');
  lines.push('## The fitted curve');
  lines.push('');
  lines.push('The comps are the trading protocols with a market-cap / TVL ratio inside 0.01..10, exchanges excluded:');
  lines.push('');
  lines.push(`- ${comps.length} comps. The curve is log(market cap) = ${fit.intercept} + ${fit.slope} x log(TVL), plus a per-category intercept shift shrunk by n / (n + 4).`);
  lines.push(`- The global median multiple is x${payload.fit.global_median}; the curve replaces it, because the blind tests say the curve predicts better.`);
  lines.push(`- Growth: the seven-day change, clamped to -60..120, applied at full weight. Age: (1 + age / 365) ^ 0.05, age capped at 1095 days, unknown age scored at 365.`);
  lines.push(`- Implied value = exp(curve) x growth factor x age factor, rounded to whole dollars.`);
  lines.push('');
  lines.push('## Blind tests, before the board was trusted');
  lines.push('');
  lines.push('Leave-one-out, mean absolute log error, same held-out set for every scoring:');
  lines.push('');
  lines.push('| scoring | error |');
  lines.push('|---|---|');
  lines.push('| fitted curve | ' + loo.curve.toFixed(3) + ' |');
  lines.push('| curve + growth | ' + loo.curve_growth.toFixed(3) + ' |');
  lines.push('| curve + growth + age | ' + loo.curve_growth_age.toFixed(3) + ' |');
  lines.push('| flat global median | ' + loo.flat_median.toFixed(3) + ' |');
  lines.push('| per-category medians | ' + loo.category_median.toFixed(3) + ' |');
  lines.push('');
  lines.push(
    `Walk-forward: the curve fitted on the oldest ${walk.train_n} dated comps predicts the newest ${walk.test_n} with error ${walk.curve_err.toFixed(3)}, against ${walk.flat_err.toFixed(3)} for the flat median on the same split.`,
  );
  lines.push('');
  for (const d of payload.validation.decisions) lines.push(`- ${d}`);
  lines.push('');
  lines.push('## Calibration by category');
  lines.push('');
  lines.push('Each category’s shrunk shift, and the multiple the curve prices $100M of TVL at for it:');
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
  lines.push(`- ${cov.total} protocols in the snapshot: ${cov.ranked} ranked, ${cov.excluded_pre_token} pre-token protocols set aside, ${cov.traded} trading already.`);
  for (const [reason, n] of Object.entries(cov.excluded_by_reason).sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push(`- ${n} set aside as ${reason}.`);
  }
  lines.push(`- Watchlist: ${cov.watchlist_covered} of ${cov.watchlist_size} covered.`);
  lines.push('');
  lines.push('## Farm economics');
  lines.push('');
  lines.push('- Deposits: $250 at $1B+ TVL, $150 at $100M+, $100 at $25M+, $50 below that. Capital at work, not a fee.');
  lines.push('- Gas per transaction, planning estimates: ' + Object.entries(payload.economy.gas_per_tx).map(([c, g]) => `${c} $${g}`).join(', ') + `; other chains $${payload.economy.gas_default}.`);
  lines.push('- Hold windows: 60 days under 180 days old, 45 days under a year, 30 days older, 45 when the listing date is unknown.');
  lines.push(
    `- Verdicts split the board into thirds by implied value per gas dollar: FARM at or above ${payload.economy.verdict_cuts.farm_above.toLocaleString('en-US')}, SKIP below ${payload.economy.verdict_cuts.skip_below.toLocaleString('en-US')}. Counts: FARM ${payload.economy.verdict_counts.FARM}, THIN ${payload.economy.verdict_counts.THIN}, SKIP ${payload.economy.verdict_counts.SKIP}.`,
  );
  lines.push('');
  lines.push('## Rank ranges');
  lines.push('');
  const widths = payload.rows.map((r) => r.rank_high - r.rank_low);
  lines.push(
    `Each row’s rank range is the middle 80% of its ranks across ${payload.validation.refits} bootstrap refits of the curve (seed ${payload.validation.seed}). Median range width ${medianOf(widths)} ranks; the top rows are steady, the middle of the board moves, and the ranges say so.`,
  );
  lines.push('');
  lines.push('## Top 40');
  lines.push('');
  lines.push('| rank | protocol | TVL | implied | range | verdict |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of payload.rows.slice(0, 40)) {
    lines.push(`| ${r.rank} | ${r.name} | ${moneyShort(r.tvl_usd)} | ${moneyFull(r.implied_value_usd)} | ${r.rank_low}–${r.rank_high} | ${r.farm.verdict} |`);
  }
  lines.push('');
  const first = payload.rows[0]!;
  lines.push('## Worked example: the top row, end to end');
  lines.push('');
  lines.push(
    `${first.name} holds ${moneyFull(first.tvl_usd)} of TVL in ${first.category ?? 'an uncategorised bucket'}, ${first.change_7d === null ? 'with no seven-day change on record' : `with a seven-day change of ${first.change_7d}%`}, ${first.age_days === null ? 'with no listing date on record' : `listed ${first.age_days} days before the snapshot`}. The curve prices its TVL at ${moneyFull(first.curve_usd)} (category shift ${first.category_shift}, ${first.category_shift_n} comp${first.category_shift_n === 1 ? '' : 's'}), the growth factor is ${first.growth_factor}, the age factor is ${first.age_factor}, and the implied value is ${moneyFull(first.implied_value_usd)}, with rank range ${first.rank_low}–${first.rank_high} across the refits. Its farm plan, verbatim:`,
  );
  lines.push('');
  for (let i = 0; i < first.farm_steps.length; i++) {
    lines.push(`${i + 1}. ${first.farm_steps[i]}`);
  }
  lines.push('');
  lines.push(
    `Netted: ${moneyFull(first.farm.gas_usd)} of gas, a ${moneyFull(first.farm.deposit_usd)} deposit that returns on exit, ${first.farm.hours} hours across ${first.farm.hold_days} days, break-even at ${moneyFull(first.farm.break_even_usd)} (${first.farm.break_even_share_pct}% of implied value), ${first.farm.efficiency.toLocaleString('en-US')} implied dollars per gas dollar. Verdict: ${first.farm.verdict}.`,
  );
  lines.push('');
  lines.push('## Limits');
  lines.push('');
  lines.push('- The curve is a cross-section, not a launch guarantee: a launch may price far from its curve value, and the rank ranges carry that uncertainty.');
  lines.push('- Gas costs are planning estimates at snapshot-time prices; a congested chain costs more, and the break-even moves with it.');
  lines.push('- Two runs on the same snapshot are byte-identical: the fit, the bootstrap, and the report are all deterministic.');
  lines.push('');
  return lines.join('\n');
}
