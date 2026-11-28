// Token-recorded odds, peer-based and tested blind. The snapshot cannot say whether
// a protocol will launch a token one day; it can say how often comparable protocols
// already record one. This module estimates exactly that — the peer token-recorded
// rate — with a fixed hierarchy (global, then age band, then category, then TVL
// band) and fixed prior strengths (20, 12, 8) chosen before any evaluation ran.
// Nothing here is swept or tuned: the bands and strengths below are the design.
//
// The estimate is then tested the same way the value model is: leave-one-out over
// the whole universe, and two chronological splits (train on the oldest 60% and
// 80% of dated protocols, test on the next 20% each). The full hierarchy is kept
// only if it beats the age-only rate by at least 1% on both log loss and Brier
// score in both evaluations; otherwise the board publishes the age-only rate and
// the raw closest-peer counts, and the record says so. Either way the number is a
// peer-recorded rate in this snapshot — never a launch probability forecast.

import { daysBetween, meanOf, roundTo } from './snapshot.ts';
import type { Protocol } from './snapshot.ts';

/** Prior strengths of the hierarchy: age toward global, category toward age, size toward category. */
export const ODDS_PRIOR_AGE = 20;
export const ODDS_PRIOR_CATEGORY = 12;
export const ODDS_PRIOR_SIZE = 8;

/** A protocol records a token when the snapshot carries a positive market cap for it. */
export function recordsToken(p: Protocol): boolean {
  return p.mcap_usd !== null && p.mcap_usd > 0;
}

/** Age bands in days since listing, fixed before evaluation; an unlisted protocol is its own band. */
export function ageBand(p: Protocol, asOf: string): string {
  const d = daysBetween(asOf, p.listed_at);
  if (d === null) return 'unknown';
  if (d < 90) return '0-89 days';
  if (d < 365) return '90-364 days';
  if (d < 1095) return '365-1094 days';
  return '1095+ days';
}

/** TVL bands, fixed before evaluation. */
export function tvlBand(p: Protocol): string {
  if (!(p.tvl_usd > 0)) return 'unknown';
  if (p.tvl_usd < 10_000_000) return 'under $10M';
  if (p.tvl_usd < 50_000_000) return '$10M-$50M';
  if (p.tvl_usd < 250_000_000) return '$50M-$250M';
  return '$250M+';
}

/** The category key: the snapshot's category, or Uncategorized when none is named. */
function categoryKey(p: Protocol): string {
  return p.category ?? 'Uncategorized';
}

/** One peer cell: how many protocols, and how many of them record a token. */
export interface PeerCell {
  n: number;
  recorded: number;
}

/** Every level of one protocol's peer evidence, raw counts beside smoothed rates. */
export interface OddsEvidence {
  /** The published rate: the full hierarchy when it passed its tests, else the age-only rate. */
  odds: number;
  /** The age-only smoothed rate, the fallback the hierarchy had to beat. */
  age_odds: number;
  /** The full hierarchy's smoothed rate, published or not. */
  hierarchy_odds: number;
  age_band: string;
  tvl_band: string;
  /** Closest peers: same age band, category, and TVL band. */
  closest: PeerCell;
  /** Category peers: same age band and category. */
  category_peers: PeerCell;
  /** Age peers: same age band. */
  age_peers: PeerCell;
}

function cell(train: Protocol[], keep: (q: Protocol) => boolean): PeerCell {
  let n = 0;
  let recorded = 0;
  for (const q of train) {
    if (!keep(q)) continue;
    n++;
    if (recordsToken(q)) recorded++;
  }
  return { n, recorded };
}

/**
 * The hierarchical estimate for one protocol from a training set that excludes it:
 * global rate smoothed (s+1)/(n+2), age toward global at strength 20, category
 * toward age at 12, size toward category at 8. Empty cells back off by construction.
 */
export function oddsFrom(train: Protocol[], p: Protocol, asOf: string): { global: number; age: number; hierarchy: number; evidence: Omit<OddsEvidence, 'odds'> } {
  const all = cell(train, () => true);
  const global = (all.recorded + 1) / (all.n + 2);
  const ab = ageBand(p, asOf);
  const agePeers = cell(train, (q) => ageBand(q, asOf) === ab);
  const age = (agePeers.recorded + ODDS_PRIOR_AGE * global) / (agePeers.n + ODDS_PRIOR_AGE);
  const catPeers = cell(train, (q) => ageBand(q, asOf) === ab && categoryKey(q) === categoryKey(p));
  const category = (catPeers.recorded + ODDS_PRIOR_CATEGORY * age) / (catPeers.n + ODDS_PRIOR_CATEGORY);
  const tb = tvlBand(p);
  const closest = cell(train, (q) => ageBand(q, asOf) === ab && categoryKey(q) === categoryKey(p) && tvlBand(q) === tb);
  const hierarchy = (closest.recorded + ODDS_PRIOR_SIZE * category) / (closest.n + ODDS_PRIOR_SIZE);
  return {
    global,
    age,
    hierarchy,
    evidence: {
      age_odds: roundTo(age, 4),
      hierarchy_odds: roundTo(hierarchy, 4),
      age_band: ab,
      tvl_band: tb,
      closest,
      category_peers: catPeers,
      age_peers: agePeers,
    },
  };
}

/** One evaluation's losses for the three rates: log loss and Brier, lower wins. */
export interface OddsLosses {
  global: { log_loss: number; brier: number };
  age_only: { log_loss: number; brier: number };
  hierarchy: { log_loss: number; brier: number };
  n: number;
}

/** The odds model's whole test record, as the dashboard and the report print it. */
export interface OddsValidation {
  base_rate: number;
  loo: OddsLosses;
  chrono_60_20: OddsLosses;
  chrono_80_20: OddsLosses;
  chrono_pooled: OddsLosses;
  dated_n: number;
  undated_n: number;
  /** True only when the hierarchy beat age-only by >=1% on both losses in both evaluations. */
  hierarchy_kept: boolean;
  decision: string;
}

function losses(pairs: Array<{ global: number; age: number; hierarchy: number; y: number }>): OddsLosses {
  const score = (pick: (r: { global: number; age: number; hierarchy: number }) => number) => ({
    log_loss: roundTo(meanOf(pairs.map((r) => -(r.y * Math.log(Math.max(pick(r), 1e-9)) + (1 - r.y) * Math.log(Math.max(1 - pick(r), 1e-9))))), 4),
    brier: roundTo(meanOf(pairs.map((r) => (pick(r) - r.y) ** 2)), 4),
  });
  return { global: score((r) => r.global), age_only: score((r) => r.age), hierarchy: score((r) => r.hierarchy), n: pairs.length };
}

function beatsBy1Pct(hierarchy: { log_loss: number; brier: number }, ageOnly: { log_loss: number; brier: number }): boolean {
  return hierarchy.log_loss <= ageOnly.log_loss * 0.99 && hierarchy.brier <= ageOnly.brier * 0.99;
}

/**
 * Both blind tests, run once: leave-one-out over all protocols (each target absent
 * from its own counts), and the two chronological splits over dated protocols with
 * identical listing dates kept on the same side. Undated protocols sit the
 * chronological test out and are counted in the record.
 */
export function validateOdds(protocols: Protocol[], asOf: string): OddsValidation {
  const y = (p: Protocol): number => (recordsToken(p) ? 1 : 0);
  const looPairs: Array<{ global: number; age: number; hierarchy: number; y: number }> = [];
  for (let i = 0; i < protocols.length; i++) {
    const held = protocols[i]!;
    const r = oddsFrom(protocols.filter((_, j) => j !== i), held, asOf);
    looPairs.push({ global: r.global, age: r.age, hierarchy: r.hierarchy, y: y(held) });
  }
  const dated = protocols
    .filter((p) => p.listed_at !== null)
    .slice()
    .sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : a.slug < b.slug ? -1 : 1));
  const splitAt = (frac: number): number => {
    let cut = Math.floor(dated.length * frac);
    while (cut < dated.length && cut > 0 && dated[cut]!.listed_at === dated[cut - 1]!.listed_at) cut++;
    return cut;
  };
  const chronoPairs = (trainFrac: number) => {
    const cut = splitAt(trainFrac);
    const train = dated.slice(0, cut);
    return dated.slice(cut, splitAt(trainFrac + 0.2)).map((p) => {
      const r = oddsFrom(train, p, asOf);
      return { global: r.global, age: r.age, hierarchy: r.hierarchy, y: y(p) };
    });
  };
  const c60 = chronoPairs(0.6);
  const c80 = chronoPairs(0.8);
  const loo = losses(looPairs);
  const chrono60 = losses(c60);
  const chrono80 = losses(c80);
  const pooled = losses([...c60, ...c80]);
  const kept = beatsBy1Pct(loo.hierarchy, loo.age_only) && beatsBy1Pct(pooled.hierarchy, pooled.age_only);
  const f = (n: number): string => n.toFixed(4);
  const decision = kept
    ? `The full hierarchy beat the age-only rate by at least 1% on log loss and Brier in both tests (leave-one-out ${f(loo.hierarchy.log_loss)}/${f(loo.hierarchy.brier)} against ${f(loo.age_only.log_loss)}/${f(loo.age_only.brier)}; chronological ${f(pooled.hierarchy.log_loss)}/${f(pooled.hierarchy.brier)} against ${f(pooled.age_only.log_loss)}/${f(pooled.age_only.brier)}), so the board publishes the hierarchy's rate.`
    : `The full hierarchy did not beat the age-only rate by 1% on both losses in both tests (leave-one-out ${f(loo.hierarchy.log_loss)}/${f(loo.hierarchy.brier)} against age-only ${f(loo.age_only.log_loss)}/${f(loo.age_only.brier)}; chronological ${f(pooled.hierarchy.log_loss)}/${f(pooled.hierarchy.brier)} against ${f(pooled.age_only.log_loss)}/${f(pooled.age_only.brier)}), so the board publishes the age-only rate beside the raw closest-peer counts, and the hierarchy's number is shown only as evidence.`;
  return {
    base_rate: roundTo(meanOf(protocols.map(y)), 4),
    loo,
    chrono_60_20: chrono60,
    chrono_80_20: chrono80,
    chrono_pooled: pooled,
    dated_n: dated.length,
    undated_n: protocols.length - dated.length,
    hierarchy_kept: kept,
    decision,
  };
}

/** One protocol's published odds: the hierarchy's rate when kept, else the age-only rate. */
export function publishedOdds(protocols: Protocol[], p: Protocol, asOf: string, hierarchyKept: boolean): OddsEvidence {
  const train = protocols.filter((q) => q.slug !== p.slug);
  const r = oddsFrom(train, p, asOf);
  return { odds: roundTo(hierarchyKept ? r.hierarchy : r.age, 4), ...r.evidence };
}
