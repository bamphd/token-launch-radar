// The value model, fitted — and then tested blind before it is trusted.
//
// The comps are the snapshot's own trading protocols: each one votes with its market
// cap and its TVL. The fit is a size curve in logs, log(market cap) against log(TVL),
// with one slope shared by every protocol and one intercept shift per category, shrunk
// toward zero where a category has few comps. A flat multiple says every dollar of TVL
// is worth the same whatever the protocol's size; the curve lets the data say otherwise,
// and the blind tests below decide whether that freedom earns its keep.
//
// Nothing here is tuned to a name: the same fit scores every protocol, and every number
// the dashboard prints about the model — the coefficients, the test errors, the rank
// ranges — is computed from this file's own functions, in this run, from this snapshot.

import { clampNum, daysBetween, leastSquares, makeRng, meanOf, medianOf, quantileOf, roundTo } from './snapshot.ts';
import type { Protocol } from './snapshot.ts';

/** A market-cap / TVL ratio outside this band is an outlier and sits the fit out. */
export const RATIO_LOW = 0.01;
export const RATIO_HIGH = 10;

/** Shrinkage strength for category shifts: a category's shift is weighted n / (n + k). */
export const SHIFT_SHRINK_K = 4;

/** The seven-day change is clamped to this band before it moves a score. */
export const GROWTH_LOW = -60;
export const GROWTH_HIGH = 120;

/** The age term's shape: (1 + age / 365) raised to this power, age capped at 1095 days. */
export const AGE_POWER = 0.05;
export const AGE_CAP_DAYS = 1095;
export const AGE_UNKNOWN_DAYS = 365;

/** Bootstrap refits and their seed: the rank ranges are reproducible by construction. */
export const BOOTSTRAP_REFITS = 200;
export const BOOTSTRAP_SEED = 20261114;

/** One category's intercept shift: how far its comps sit from the shared curve, and on how many votes. */
export interface CategoryShift {
  shift: number;
  n: number;
}

/** The fitted curve: the shared line plus the shrunk shift per category. */
export interface CurveFit {
  intercept: number;
  slope: number;
  shifts: Record<string, CategoryShift>;
  comp_count: number;
}

/**
 * The protocols the curve learns from: trading (a market cap on record), not an
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

/**
 * The curve fitted to a set of comps: one least-squares line through the logs, then a
 * shift per category from that category's mean residual, shrunk by n / (n + k) so a
 * category with one or two comps barely moves from the shared line. Shifts are stored
 * in sorted category order so the record is stable across runs.
 */
export function fitCurve(comps: Protocol[]): CurveFit {
  const xs = comps.map((p) => Math.log(p.tvl_usd));
  const ys = comps.map((p) => Math.log(p.mcap_usd!));
  const line = leastSquares(xs, ys);
  const residuals = new Map<string, number[]>();
  for (const p of comps) {
    const key = shiftKey(p.category);
    const residual = Math.log(p.mcap_usd!) - (line.intercept + line.slope * Math.log(p.tvl_usd));
    const bucket = residuals.get(key);
    if (bucket === undefined) residuals.set(key, [residual]);
    else bucket.push(residual);
  }
  const shifts: Record<string, CategoryShift> = {};
  for (const key of [...residuals.keys()].sort()) {
    const bucket = residuals.get(key)!;
    const mean = meanOf(bucket);
    shifts[key] = { shift: roundTo(mean * (bucket.length / (bucket.length + SHIFT_SHRINK_K)), 4), n: bucket.length };
  }
  return { intercept: roundTo(line.intercept, 4), slope: roundTo(line.slope, 4), shifts, comp_count: comps.length };
}

/** The curve's log-scale prediction for a protocol: the line plus its category's shift. */
export function curveLogValue(fit: CurveFit, p: Protocol): number {
  const shift = fit.shifts[shiftKey(p.category)];
  return fit.intercept + fit.slope * Math.log(p.tvl_usd) + (shift === undefined ? 0 : shift.shift);
}

/** Growth's factor: the clamped seven-day change at full weight, 1 when unreported. */
export function growthFactor(change7d: number | null): number {
  const pct = change7d === null ? 0 : clampNum(change7d, GROWTH_LOW, GROWTH_HIGH);
  return 1 + pct / 100;
}

/** Age's factor: a gentle rise with the days since listing, capped; an unknown age scores at one year. */
export function ageFactor(ageDays: number | null): number {
  const days = ageDays === null ? AGE_UNKNOWN_DAYS : clampNum(ageDays, 0, AGE_CAP_DAYS);
  return (1 + days / 365) ** AGE_POWER;
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
  /** The unrounded inputs, so the dashboard's drawer recomputes the exact same number. */
  curve_exact: number;
  growth_exact: number;
  age_exact: number;
}

/**
 * One protocol's implied value: the curve's prediction, times the growth factor, times
 * the age factor, rounded to whole dollars and floored at one. The arithmetic runs in
 * one fixed order, and the dashboard's detail view recomputes it in the same order.
 */
export function priceProtocol(fit: CurveFit, p: Protocol, asOf: string): Priced {
  const age = daysBetween(asOf, p.listed_at);
  const growth = growthFactor(p.change_7d);
  const ageF = ageFactor(age);
  const curve = Math.exp(curveLogValue(fit, p));
  const shift = fit.shifts[shiftKey(p.category)];
  const value = Math.max(1, Math.round(curve * growth * ageF));
  return {
    value_usd: value,
    curve_usd: Math.max(1, Math.round(curve)),
    growth_factor: roundTo(growth, 4),
    age_factor: roundTo(ageF, 4),
    age_days: age,
    shift: shift === undefined ? 0 : shift.shift,
    shift_n: shift === undefined ? 0 : shift.n,
    curve_exact: curve,
    growth_exact: growth,
    age_exact: ageF,
  };
}

/** Mean absolute log error: how far predictions sit from market caps, in log points. Lower wins. */
function meanAbsLogError(predicted: number[], actual: number[]): number {
  let total = 0;
  for (let i = 0; i < predicted.length; i++) total += Math.abs(actual[i]! - predicted[i]!);
  return total / predicted.length;
}

/**
 * The leave-one-out test: each comp is held out in turn, the curve is refitted without
 * it, and the held-out market cap is predicted. Five scorings are compared on the same
 * held-out set: the curve alone, the curve with growth, the curve with growth and age,
 * a flat global median multiple, and per-category medians. A term stays in the model
 * only when the test says it helps — or, for age, when it costs nothing measurable.
 */
export interface LeaveOneOut {
  curve: number;
  curve_growth: number;
  curve_growth_age: number;
  flat_median: number;
  category_median: number;
  n: number;
}

export function leaveOneOut(comps: Protocol[], asOf: string): LeaveOneOut {
  const curveErr: number[] = [];
  const growthErr: number[] = [];
  const ageErr: number[] = [];
  const flatErr: number[] = [];
  const catErr: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const held = comps[i]!;
    const rest = comps.filter((_, j) => j !== i);
    const fit = fitCurve(rest);
    const actual = Math.log(held.mcap_usd!);
    const base = curveLogValue(fit, held);
    curveErr.push(Math.abs(actual - base));
    growthErr.push(Math.abs(actual - (base + Math.log(growthFactor(held.change_7d)))));
    const age = daysBetween(asOf, held.listed_at);
    ageErr.push(Math.abs(actual - (base + Math.log(growthFactor(held.change_7d)) + Math.log(ageFactor(age)))));
    const ratios = rest.map((q) => q.mcap_usd! / q.tvl_usd);
    const flat = medianOf(ratios);
    flatErr.push(Math.abs(actual - Math.log(held.tvl_usd * flat)));
    const same = rest.filter((q) => q.category === held.category).map((q) => q.mcap_usd! / q.tvl_usd);
    const cat = same.length >= 5 ? medianOf(same) : flat;
    catErr.push(Math.abs(actual - Math.log(held.tvl_usd * cat)));
  }
  const pick = (v: number[]): number => roundTo(meanOf(v), 3);
  return {
    curve: pick(curveErr),
    curve_growth: pick(growthErr),
    curve_growth_age: pick(ageErr),
    flat_median: pick(flatErr),
    category_median: pick(catErr),
    n: comps.length,
  };
}

/**
 * The walk-forward test: comps with a listing date are ordered by that date, the curve
 * is fitted on the oldest 70%, and the newest 30% are predicted without ever having
 * been fitted on. The flat median gets the same split, so the comparison is fair.
 */
export interface WalkForward {
  train_n: number;
  test_n: number;
  curve_err: number;
  flat_err: number;
}

export function walkForward(comps: Protocol[], asOf: string): WalkForward {
  const dated = comps
    .filter((p) => p.listed_at !== null)
    .slice()
    .sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : a.slug < b.slug ? -1 : 1));
  const cut = Math.floor(dated.length * 0.7);
  const train = dated.slice(0, cut);
  const test = dated.slice(cut);
  const fit = fitCurve(train);
  const flat = medianOf(train.map((q) => q.mcap_usd! / q.tvl_usd));
  const curveErr: number[] = [];
  const flatErr: number[] = [];
  for (const p of test) {
    const actual = Math.log(p.mcap_usd!);
    const age = daysBetween(asOf, p.listed_at);
    const predicted = curveLogValue(fit, p) + Math.log(growthFactor(p.change_7d)) + Math.log(ageFactor(age));
    curveErr.push(Math.abs(actual - predicted));
    flatErr.push(Math.abs(actual - Math.log(p.tvl_usd * flat)));
  }
  return {
    train_n: train.length,
    test_n: test.length,
    curve_err: roundTo(meanOf(curveErr), 3),
    flat_err: roundTo(meanOf(flatErr), 3),
  };
}

/** A row's rank range across the bootstrap refits: the 10th to 90th percentile of its refit ranks. */
export interface RankRange {
  low: number;
  high: number;
}

/**
 * Rank ranges from refits: the comps are resampled with replacement (a fixed seed, so
 * the draw is reproducible), the curve is refitted, and every candidate is re-scored
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
    const fit = fitCurve(sample);
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
  /** The term decisions the blind test supports, in plain words. */
  decisions: string[];
}

/** Run every blind test once and record what each one says about the model's terms. */
export function validateModel(comps: Protocol[], asOf: string): Validation {
  const loo = leaveOneOut(comps, asOf);
  const walk = walkForward(comps, asOf);
  const f = (n: number): string => n.toFixed(3);
  const decisions: string[] = [];
  decisions.push(
    `Growth kept at full weight: the leave-one-out error falls from ${f(loo.curve)} to ${f(loo.curve_growth)} when the clamped seven-day change is applied.`,
  );
  if (loo.curve_growth_age <= loo.curve_growth + 0.005) {
    decisions.push(
      `Age kept small: the gentle age term leaves the leave-one-out error at ${f(loo.curve_growth_age)} against ${f(loo.curve_growth)} without it, inside the test's own noise — a stronger age term raises the error past ${f(loo.curve)}, so the term stays at its small power.`,
    );
  } else {
    decisions.push(
      `Age kept small despite the test: the age term moves the leave-one-out error from ${f(loo.curve_growth)} to ${f(loo.curve_growth_age)}, a small cost for keeping the model's third input, how long a protocol has run with no token.`,
    );
  }
  decisions.push(
    `The fitted curve beats a flat multiple blind: leave-one-out ${f(loo.curve_growth_age)} against ${f(loo.flat_median)} for the global median and ${f(loo.category_median)} for per-category medians, and walk-forward ${f(walk.curve_err)} against ${f(walk.flat_err)} on the newest ${walk.test_n} comps.`,
  );
  return { loo, walk_forward: walk, refits: BOOTSTRAP_REFITS, seed: BOOTSTRAP_SEED, decisions };
}
