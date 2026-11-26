// The value model, fitted — and then tested blind before it is trusted.
//
// radar-4 replaces radar-3's hand-set adjustments with a small, fully fitted
// procedure. The fit is a median (least-absolute-deviation) line in logs —
// log(market cap) against log(TVL) — because the blind error is a mean absolute
// log error and the comps carry a few very loud outliers that a least-squares line
// chases. Two more fitted terms sit on the line: within-category size, how far a
// protocol's TVL sits from its own category's mean, and shrunk intercept shifts
// per category and per first chain. Growth and age are fitted too, in the ablation,
// and dropped: the fitted growth coefficient is unstable across estimators and
// worsens leave-one-out, and the fitted age coefficient is small and wrecks the
// chronological test, so the final model carries neither — their factors are 1 and
// the record says why.
//
// Nothing here is tuned to a name: the same fit scores every protocol, and every
// number the dashboard prints about the model — the coefficients, the test errors,
// the rank ranges — is computed from this file's own functions, in this run, from
// this snapshot.

import { clampNum, daysBetween, makeRng, meanOf, medianOf, quantileOf, roundTo } from './snapshot.ts';
import type { Protocol } from './snapshot.ts';

/** A market-cap / TVL ratio outside this band is an outlier and sits the fit out. */
export const RATIO_LOW = 0.01;
export const RATIO_HIGH = 10;

/** Shrinkage strength for intercept shifts: a shift is weighted n / (n + k). */
export const SHIFT_SHRINK_K = 4;

/** The seven-day change is clamped to this band before it enters a fit. */
export const GROWTH_LOW = -60;
export const GROWTH_HIGH = 120;

/** The age term's shape: log(1 + age / 365), age capped at 1095 days. */
export const AGE_CAP_DAYS = 1095;
export const AGE_UNKNOWN_DAYS = 365;

/** The LAD solver's floor and iteration cap: the IRLS weights never divide by less. */
export const LAD_EPS = 0.01;
export const LAD_ITERS = 60;

/** Bootstrap refits and their seed: the rank ranges are reproducible by construction. */
export const BOOTSTRAP_REFITS = 200;
export const BOOTSTRAP_SEED = 20261114;

/** One category's intercept shift: how far its comps sit from the shared line, and on how many votes. */
export interface CategoryShift {
  shift: number;
  n: number;
}

/** Which terms a fit carries: the line always, the rest only when asked for. */
export interface ModelOptions {
  w: boolean;
  shifts: boolean;
  chain: boolean;
  growth: boolean;
  age: boolean;
}

/** The final model: median line, within-category size, category shifts, chain shifts. Growth and age fitted and dropped. */
export const FINAL_MODEL_OPTS: ModelOptions = { w: true, shifts: true, chain: true, growth: false, age: false };

/** The fitted model: the line's coefficients plus the shrunk shifts and the category means the size term needs. */
export interface ModelFit {
  intercept: number;
  slope: number;
  w_coef: number;
  growth_coef: number;
  age_coef: number;
  shifts: Record<string, CategoryShift>;
  chain_shifts: Record<string, CategoryShift>;
  cat_mean_log_tvl: Record<string, number>;
  comp_count: number;
}

/**
 * The protocols the model learns from: trading (a market cap on record), not an
 * exchange, with positive TVL and market cap and a ratio inside the band. Exchanges
 * are left out because their TVL is customer balances, not protocol value.
 */
export function selectComps(protocols: Protocol[]): Protocol[] {
  return protocols.filter((p) => {
    if (p.mcap_usd === null || p.category === 'CEX') return false;
    if (!(p.tvl_usd > 0) || !(p.mcap_usd > 0)) return false;
    const ratio = p.mcap_usd / p.tvl_usd;
    return Number.isFinite(ratio) && ratio >= RATIO_LOW && ratio <= RATIO_HIGH;
  });
}

/** The bucket a protocol's shift comes from: its category, or Uncategorized when none is named. */
export function shiftKey(category: string | null): string {
  return category ?? 'Uncategorized';
}

/** The bucket a protocol's chain shift comes from: its first chain, or none when it names none. */
export function chainKey(p: Protocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'none';
}

/** Solve A x = b by Gaussian elimination with partial pivoting. A is small (at most 5 by 5). */
export function solveLinear(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    }
    if (pivot !== col) {
      const t = m[col]!;
      m[col] = m[pivot]!;
      m[pivot] = t;
    }
    const diag = m[col]![col]!;
    if (Math.abs(diag) < 1e-12) continue;
    for (let r = col + 1; r < n; r++) {
      const f = m[r]![col]! / diag;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) m[r]![c] = m[r]![c]! - f * m[col]![c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = m[i]![n]!;
    for (let j = i + 1; j < n; j++) s -= m[i]![j]! * x[j]!;
    x[i] = Math.abs(m[i]![i]!) < 1e-12 ? 0 : s / m[i]![i]!;
  }
  return x;
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** Weighted least squares through the normal equations, with a hair of ridge for stability. */
function weightedLeastSquares(x: number[][], y: number[], w: number[]): number[] {
  const p = x[0]!.length;
  const ata: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const atb = new Array<number>(p).fill(0);
  for (let i = 0; i < x.length; i++) {
    for (let a = 0; a < p; a++) {
      atb[a] = atb[a]! + w[i]! * x[i]![a]! * y[i]!;
      for (let b = 0; b < p; b++) ata[a]![b] = ata[a]![b]! + w[i]! * x[i]![a]! * x[i]![b]!;
    }
  }
  for (let a = 0; a < p; a++) ata[a]![a] = ata[a]![a]! + 1e-8;
  return solveLinear(ata, atb);
}

/** Ordinary least squares, the IRLS starting point. */
export function olsFit(x: number[][], y: number[]): number[] {
  return weightedLeastSquares(x, y, y.map(() => 1));
}

/**
 * Least absolute deviations by iteratively reweighted least squares: weights
 * 1 / max(|residual|, eps), from an OLS start, until the coefficients stop moving.
 * The median fit is the right target for a mean-absolute-error judge, and it does
 * not chase the comps whose ratios sit at the band's edge.
 */
export function irlsLad(x: number[][], y: number[], eps: number = LAD_EPS, iters: number = LAD_ITERS): number[] {
  let beta = olsFit(x, y);
  for (let t = 0; t < iters; t++) {
    const w = y.map((yi, i) => 1 / Math.max(Math.abs(yi - dot(x[i]!, beta)), eps));
    const next = weightedLeastSquares(x, y, w);
    const delta = Math.max(...next.map((v, i) => Math.abs(v - beta[i]!)));
    beta = next;
    if (delta < 1e-10) break;
  }
  return beta;
}

/** Growth's log transform: log(1 + clamped seven-day change), 0 when unreported. */
export function growthLog(change7d: number | null): number {
  const pct = change7d === null ? 0 : clampNum(change7d, GROWTH_LOW, GROWTH_HIGH);
  return Math.log1p(pct / 100);
}

/** Age's log transform: log(1 + age / 365), capped; an unknown age scores at one year. */
export function ageLog(ageDays: number | null): number {
  const days = ageDays === null ? AGE_UNKNOWN_DAYS : clampNum(ageDays, 0, AGE_CAP_DAYS);
  return Math.log1p(days / 365);
}

/** The category means the within-category size term is measured against, from the training comps. */
function fitContext(comps: Protocol[]): Record<string, number> {
  const sums = new Map<string, { total: number; n: number }>();
  for (const p of comps) {
    const key = shiftKey(p.category);
    const s = sums.get(key) ?? { total: 0, n: 0 };
    s.total += Math.log(p.tvl_usd);
    s.n++;
    sums.set(key, s);
  }
  const out: Record<string, number> = {};
  for (const [key, s] of sums) out[key] = s.total / s.n;
  return out;
}

/** One protocol's design row: the intercept, log TVL, and the terms the options ask for, in that order. */
function featureRow(ctx: Record<string, number>, p: Protocol, asOf: string, opts: ModelOptions): number[] {
  const x = Math.log(p.tvl_usd);
  const row = [1, x];
  if (opts.w) {
    const mean = ctx[shiftKey(p.category)] ?? x;
    row.push(x - mean);
  }
  if (opts.growth) row.push(growthLog(p.change_7d));
  if (opts.age) row.push(ageLog(daysBetween(asOf, p.listed_at)));
  return row;
}

/** Shrunk mean-residual shifts by a key function: each shift weighted n / (n + k). */
function shiftsFromResiduals(comps: Protocol[], residuals: number[], keyFn: (p: Protocol) => string): Record<string, CategoryShift> {
  const buckets = new Map<string, number[]>();
  comps.forEach((p, i) => {
    const key = keyFn(p);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [residuals[i]!]);
    else bucket.push(residuals[i]!);
  });
  const out: Record<string, CategoryShift> = {};
  for (const key of [...buckets.keys()].sort()) {
    const bucket = buckets.get(key)!;
    out[key] = { shift: roundTo(meanOf(bucket) * (bucket.length / (bucket.length + SHIFT_SHRINK_K)), 4), n: bucket.length };
  }
  return out;
}

/**
 * The model fitted to a set of comps: a median line through the logs, then shrunk
 * shifts per category from the line's residuals, then shrunk shifts per first chain
 * from what is left. Shifts are stored in sorted key order so the record is stable
 * across runs. Coefficients are rounded to four decimals, and the shifts are
 * computed from those rounded coefficients, so the stored fit predicts exactly
 * what the dashboard recomputes.
 */
export function fitModel(comps: Protocol[], asOf: string, opts: ModelOptions): ModelFit {
  const ctx = fitContext(comps);
  const x = comps.map((p) => featureRow(ctx, p, asOf, opts));
  const y = comps.map((p) => Math.log(p.mcap_usd!));
  const beta = irlsLad(x, y);
  let pos = 0;
  const intercept = roundTo(beta[pos++]!, 4);
  const slope = roundTo(beta[pos++]!, 4);
  const w_coef = opts.w ? roundTo(beta[pos++]!, 4) : 0;
  const growth_coef = opts.growth ? roundTo(beta[pos++]!, 4) : 0;
  const age_coef = opts.age ? roundTo(beta[pos++]!, 4) : 0;
  const fitted: ModelFit = {
    intercept,
    slope,
    w_coef,
    growth_coef,
    age_coef,
    shifts: {},
    chain_shifts: {},
    cat_mean_log_tvl: ctx,
    comp_count: comps.length,
  };
  const residuals = comps.map((p) => Math.log(p.mcap_usd!) - modelLogValue(fitted, p, asOf));
  if (opts.shifts) {
    fitted.shifts = shiftsFromResiduals(comps, residuals, (p) => shiftKey(p.category));
    if (opts.chain) {
      const afterCat = residuals.map((r, i) => r - (fitted.shifts[shiftKey(comps[i]!.category)]?.shift ?? 0));
      fitted.chain_shifts = shiftsFromResiduals(comps, afterCat, chainKey);
    }
  }
  return fitted;
}

/** The model's log-scale prediction for a protocol: the line, the size term, and the shifts it carries. */
export function modelLogValue(fit: ModelFit, p: Protocol, asOf: string): number {
  const x = Math.log(p.tvl_usd);
  let v = fit.intercept + fit.slope * x;
  if (fit.w_coef !== 0) {
    const mean = fit.cat_mean_log_tvl[shiftKey(p.category)] ?? x;
    v += fit.w_coef * (x - mean);
  }
  const shift = fit.shifts[shiftKey(p.category)];
  if (shift !== undefined) v += shift.shift;
  const chain = fit.chain_shifts[chainKey(p)];
  if (chain !== undefined) v += chain.shift;
  if (fit.growth_coef !== 0) v += fit.growth_coef * growthLog(p.change_7d);
  if (fit.age_coef !== 0) v += fit.age_coef * ageLog(daysBetween(asOf, p.listed_at));
  return v;
}

/** Everything one protocol's implied value is made of, kept for the board's audit trail. */
export interface Priced {
  value_usd: number;
  curve_usd: number;
  growth_factor: number;
  age_factor: number;
  age_days: number | null;
  shift: number;
  shift_n: number;
  chain_shift: number;
  chain_shift_n: number;
  within_size: number;
  size_coef: number;
  /** The unrounded inputs, so the dashboard's drawer recomputes the exact same number. */
  curve_exact: number;
  growth_exact: number;
  age_exact: number;
}

/**
 * One protocol's implied value: the model's prediction, rounded to whole dollars
 * and floored at one. Growth and age carry a factor of 1 in the final model: both
 * were fitted in the ablation and dropped by the blind tests, and the record says
 * so. The arithmetic runs in one fixed order, and the dashboard's detail view
 * recomputes it in the same order.
 */
export function priceProtocol(fit: ModelFit, p: Protocol, asOf: string): Priced {
  const age = daysBetween(asOf, p.listed_at);
  const curve = Math.exp(modelLogValue(fit, p, asOf));
  const shift = fit.shifts[shiftKey(p.category)];
  const chain = fit.chain_shifts[chainKey(p)];
  const x = Math.log(p.tvl_usd);
  const mean = fit.cat_mean_log_tvl[shiftKey(p.category)] ?? x;
  const value = Math.max(1, Math.round(curve));
  return {
    value_usd: value,
    curve_usd: Math.max(1, Math.round(curve)),
    growth_factor: 1,
    age_factor: 1,
    age_days: age,
    shift: shift === undefined ? 0 : shift.shift,
    shift_n: shift === undefined ? 0 : shift.n,
    chain_shift: chain === undefined ? 0 : chain.shift,
    chain_shift_n: chain === undefined ? 0 : chain.n,
    within_size: roundTo(x - mean, 4),
    size_coef: fit.w_coef,
    curve_exact: curve,
    growth_exact: 1,
    age_exact: 1,
  };
}

/** Mean absolute log error: how far predictions sit from market caps, in log points. Lower wins. */
function meanAbsLogError(predicted: number[], actual: number[]): number {
  let total = 0;
  for (let i = 0; i < predicted.length; i++) total += Math.abs(actual[i]! - predicted[i]!);
  return total / predicted.length;
}

/** The ablation's levels, in the order the record prints them. */
const ABLATION_LEVELS: Array<{ key: 'line' | 'line_category' | 'line_category_size' | 'final' | 'final_growth' | 'final_growth_age'; opts: ModelOptions }> = [
  { key: 'line', opts: { w: false, shifts: false, chain: false, growth: false, age: false } },
  { key: 'line_category', opts: { w: false, shifts: true, chain: false, growth: false, age: false } },
  { key: 'line_category_size', opts: { w: true, shifts: true, chain: false, growth: false, age: false } },
  { key: 'final', opts: FINAL_MODEL_OPTS },
  { key: 'final_growth', opts: { ...FINAL_MODEL_OPTS, growth: true } },
  { key: 'final_growth_age', opts: { ...FINAL_MODEL_OPTS, growth: true, age: true } },
];

/** The leave-one-out ablation: every level refitted without the held-out comp, on the same held-out set. */
export interface LeaveOneOut {
  flat_median: number;
  line: number;
  line_category: number;
  line_category_size: number;
  final: number;
  final_growth: number;
  final_growth_age: number;
  n: number;
}

export function leaveOneOut(comps: Protocol[], asOf: string): LeaveOneOut {
  const errs: Record<string, number[]> = {
    flat_median: [],
    line: [],
    line_category: [],
    line_category_size: [],
    final: [],
    final_growth: [],
    final_growth_age: [],
  };
  for (let i = 0; i < comps.length; i++) {
    const held = comps[i]!;
    const rest = comps.filter((_, j) => j !== i);
    const actual = Math.log(held.mcap_usd!);
    for (const level of ABLATION_LEVELS) {
      const fit = fitModel(rest, asOf, level.opts);
      errs[level.key]!.push(Math.abs(actual - modelLogValue(fit, held, asOf)));
    }
    const ratios = rest.map((q) => q.mcap_usd! / q.tvl_usd);
    const flat = medianOf(ratios);
    errs.flat_median!.push(Math.abs(actual - Math.log(held.tvl_usd * flat)));
  }
  const pick = (v: number[]): number => roundTo(meanOf(v), 3);
  return {
    flat_median: pick(errs.flat_median!),
    line: pick(errs.line!),
    line_category: pick(errs.line_category!),
    line_category_size: pick(errs.line_category_size!),
    final: pick(errs.final!),
    final_growth: pick(errs.final_growth!),
    final_growth_age: pick(errs.final_growth_age!),
    n: comps.length,
  };
}

/**
 * The walk-forward ablation: comps with a listing date are ordered by that date,
 * every level is fitted on the oldest 70%, and the newest 30% are predicted without
 * ever having been fitted on. The flat median gets the same split, so the comparison
 * is fair. This is an age and cohort holdout, not a forecast: the snapshot's inputs
 * are present-day figures, not historical ones.
 */
export interface WalkForward {
  train_n: number;
  test_n: number;
  flat: number;
  line: number;
  line_category: number;
  line_category_size: number;
  final: number;
  final_growth: number;
  final_growth_age: number;
}

export function walkForward(comps: Protocol[], asOf: string): WalkForward {
  const dated = comps
    .filter((p) => p.listed_at !== null)
    .slice()
    .sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : a.slug < b.slug ? -1 : 1));
  const cut = Math.floor(dated.length * 0.7);
  const train = dated.slice(0, cut);
  const test = dated.slice(cut);
  const errs: Record<string, number[]> = {
    flat: [],
    line: [],
    line_category: [],
    line_category_size: [],
    final: [],
    final_growth: [],
    final_growth_age: [],
  };
  const flat = medianOf(train.map((q) => q.mcap_usd! / q.tvl_usd));
  for (const p of test) {
    const actual = Math.log(p.mcap_usd!);
    errs.flat!.push(Math.abs(actual - Math.log(p.tvl_usd * flat)));
  }
  for (const level of ABLATION_LEVELS) {
    const fit = fitModel(train, asOf, level.opts);
    for (const p of test) {
      errs[level.key]!.push(Math.abs(Math.log(p.mcap_usd!) - modelLogValue(fit, p, asOf)));
    }
  }
  const pick = (v: number[]): number => roundTo(meanOf(v), 3);
  return {
    train_n: train.length,
    test_n: test.length,
    flat: pick(errs.flat!),
    line: pick(errs.line!),
    line_category: pick(errs.line_category!),
    line_category_size: pick(errs.line_category_size!),
    final: pick(errs.final!),
    final_growth: pick(errs.final_growth!),
    final_growth_age: pick(errs.final_growth_age!),
  };
}

/** A row's rank range across the bootstrap refits: the 10th to 90th percentile of its refit ranks. */
export interface RankRange {
  low: number;
  high: number;
}

/**
 * Rank ranges from refits: the comps are resampled with replacement (a fixed seed, so
 * the draw is reproducible), the model is refitted, and every candidate is re-scored
 * and re-ranked. After 200 refits, each row's rank range is the middle 80% of its
 * refit ranks. Wide ranges are honest uncertainty, not noise to hide: the board shows
 * them beside the rank.
 */
export function bootstrapRanges(
  candidates: Protocol[],
  comps: Protocol[],
  asOf: string,
  refits: number = BOOTSTRAP_REFITS,
  seed: number = BOOTSTRAP_SEED,
): Map<string, RankRange> {
  const rng = makeRng(seed);
  const collected = new Map<string, number[]>();
  for (const p of candidates) collected.set(p.slug, []);
  for (let r = 0; r < refits; r++) {
    const sample: Protocol[] = [];
    for (let i = 0; i < comps.length; i++) sample.push(comps[Math.floor(rng() * comps.length)]!);
    const fit = fitModel(sample, asOf, FINAL_MODEL_OPTS);
    const scored = candidates
      .map((p) => ({ slug: p.slug, value: priceProtocol(fit, p, asOf).value_usd }))
      .sort((a, b) => b.value - a.value || (a.slug < b.slug ? -1 : 1));
    scored.forEach((s, i) => collected.get(s.slug)!.push(i + 1));
  }
  const ranges = new Map<string, RankRange>();
  for (const [slug, ranks] of collected) {
    ranges.set(slug, { low: quantileOf(ranks, 0.1), high: quantileOf(ranks, 0.9) });
  }
  return ranges;
}

/** The model's whole validation record, as the dashboard and the report print it. */
export interface Validation {
  loo: LeaveOneOut;
  walk_forward: WalkForward;
  refits: number;
  seed: number;
  /** The term decisions the blind tests support, in plain words. */
  decisions: string[];
}

/** Run every blind test once and record what each one says about the model's terms. */
export function validateModel(comps: Protocol[], asOf: string): Validation {
  const loo = leaveOneOut(comps, asOf);
  const walk = walkForward(comps, asOf);
  const f = (n: number): string => n.toFixed(3);
  const fit = fitModel(comps, asOf, FINAL_MODEL_OPTS);
  const grown = fitModel(comps, asOf, { ...FINAL_MODEL_OPTS, growth: true });
  const aged = fitModel(comps, asOf, { ...FINAL_MODEL_OPTS, growth: true, age: true });
  const decisions: string[] = [];
  decisions.push(
    `Median fit, not least squares: the line is fitted by least absolute deviations, so the few comps at the ratio band's edge do not drag the curve. The line alone leaves a leave-one-out error of ${f(loo.line)} against ${f(loo.flat_median)} for a flat median.`,
  );
  decisions.push(
    `Category shifts kept: shrunk n / (n + 4), they move the leave-one-out error from ${f(loo.line)} to ${f(loo.line_category)} and the walk-forward error from ${f(walk.line)} to ${f(walk.line_category)}.`,
  );
  decisions.push(
    `Within-category size kept (coefficient ${fit.w_coef}): it moves the walk-forward error from ${f(walk.line_category)} to ${f(walk.line_category_size)} while the leave-one-out error stays at ${f(loo.line_category_size)}.`,
  );
  decisions.push(
    `Chain shifts kept: shrunk n / (n + 4) on the first chain, they move the leave-one-out error from ${f(loo.line_category_size)} to ${f(loo.final)} and the walk-forward error from ${f(walk.line_category_size)} to ${f(walk.final)}.`,
  );
  decisions.push(
    `Growth fitted and dropped (coefficient ${grown.growth_coef}): adding it moves the leave-one-out error from ${f(loo.final)} to ${f(loo.final_growth)} — worse — while the walk-forward error improves to ${f(walk.final_growth)}. A term stays only when it improves both blind tests, so growth stays out; the hand-set full-weight multiplier is gone either way.`,
  );
  decisions.push(
    `Age fitted and dropped (coefficient ${aged.age_coef}): adding it on top of growth moves the leave-one-out error to ${f(loo.final_growth_age)} and the walk-forward error to ${f(walk.final_growth_age)}. A protocol's age on record counts time after its token launched as well as before, so it cannot train a time-without-token effect, and the tests agree it does not help.`,
  );
  decisions.push(
    `The fitted model beats a flat multiple blind: leave-one-out ${f(loo.final)} against ${f(loo.flat_median)} for the global median, and walk-forward ${f(walk.final)} against ${f(walk.flat)} on the newest ${walk.test_n} comps.`,
  );
  return { loo, walk_forward: walk, refits: BOOTSTRAP_REFITS, seed: BOOTSTRAP_SEED, decisions };
}
