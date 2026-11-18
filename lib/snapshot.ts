// The sealed snapshot, read and measured. Everything downstream — the fitted curve, the
// blind tests, the board — starts from the ten fields of each protocol record in
// snapshot.json, and nothing else. No network, no clock, no hand-kept list: the same
// bytes in always produce the same measurements out.

/** One protocol record: exactly the ten fields the frozen snapshot carries. */
export interface Protocol {
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

/** The snapshot document: the fetch date, the floor, the index, and the watchlist. */
export interface SnapshotDoc {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

/** The snapshot text failed its shape check; the message names the first thing wrong. */
export class SnapshotReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotReadError';
  }
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Whole days from `listedAt` to `asOf`, read as UTC midnights, never negative. Null when the listing date is missing or unparseable. */
export function daysBetween(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null || !DATE_ONLY.test(listedAt) || !DATE_ONLY.test(asOf)) return null;
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  const end = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - start) / DAY_MS));
}

/** A calendar date `days` after `asOf`, as YYYY-MM-DD in UTC. */
export function plusDays(asOf: string, days: number): string {
  const base = Date.parse(`${asOf}T00:00:00Z`);
  return new Date(base + days * DAY_MS).toISOString().slice(0, 10);
}

/** `n` held inside [low, high]. */
export function clampNum(n: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, n));
}

/** `n` rounded to `places` decimals. */
export function roundTo(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/** The middle of a list of numbers; the input is never mutated. */
export function medianOf(values: number[]): number {
  const ordered = values.slice().sort((a, b) => a - b);
  const span = ordered.length - 1;
  return (ordered[Math.floor(span / 2)]! + ordered[Math.ceil(span / 2)]!) / 2;
}

/** The arithmetic mean of a list; 0 for an empty one. */
export function meanOf(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** A quantile of a list, by nearest rank; the input is never mutated. */
export function quantileOf(values: number[], q: number): number {
  const ordered = values.slice().sort((a, b) => a - b);
  const at = Math.min(ordered.length - 1, Math.max(0, Math.floor(q * ordered.length)));
  return ordered[at]!;
}

/** Ordinary least squares on paired points: the line y = intercept + slope * x. */
export function leastSquares(xs: number[], ys: number[]): { intercept: number; slope: number } {
  const mx = meanOf(xs);
  const my = meanOf(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  return { intercept: my - slope * mx, slope };
}

/**
 * A small seeded generator (mulberry32), so the bootstrap refits are reproducible: the
 * same seed always draws the same resamples, and two runs of the program agree byte for
 * byte. The seed is part of the model's record, printed beside the refit count.
 */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One protocol entry out of untrusted JSON, with every field coerced or refused. */
function readProtocol(v: unknown, i: number): Protocol {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new SnapshotReadError(`protocol ${i} is not an object`);
  }
  const p = v as Record<string, unknown>;
  if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
    throw new SnapshotReadError(`protocol ${i} lacks a slug, a name or a TVL`);
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

/** The snapshot out of a file's text, refused unless it is exactly the shape the model reads. */
export function readSnapshot(text: string): SnapshotDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotReadError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotReadError('snapshot.json is not a JSON object');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !DATE_ONLY.test(o.as_of)) throw new SnapshotReadError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotReadError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new SnapshotReadError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(o.protocols)) throw new SnapshotReadError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotReadError('snapshot.json has no watchlist of slugs');
  }
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols: o.protocols.map((v, i) => readProtocol(v, i)),
    watchlist: o.watchlist as string[],
  };
}
