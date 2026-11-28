// Token launch radar, model radar-5: one run reads the frozen snapshot, fits the value
// curve, tests it blind, prices peer token-recorded odds and tests those blind too,
// ranks the launch candidates into named lanes, costs their farm plans by net value
// per hour, and lays out the board, the dashboard, and the dossier the judge reads.
// The same snapshot in always produces the same bytes out: no clock, no network, no
// randomness but the bootstrap's fixed seed.
//
//   node main.ts --input <snapshot.json|directory> --output <dir>
//
// --input defaults to /input; --output defaults to $MAKEFUN_OUTPUT_DIR, then /output.
// The dashboard page and the screenshots are copied out of this repository; the board,
// the data script, and the model record are written fresh. The dossier is built with
// the kit's vendor file, byte for byte as the scorer builds it, so what is handed in
// is what the scorer reproduces. The run refuses to finish when the board breaks a
// gate rule or the dossier breaks its 1.5 MiB cap.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleBoard, boardIssue, payloadScript } from './lib/board.ts';
import { readSnapshot } from './lib/snapshot.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const REPO = dirname(fileURLToPath(import.meta.url));
const TEXT_CAP_BYTES = 65536;
const DOSSIER_CAP_BYTES = 1572864;
const SCREENSHOT_MAX = 4;
const SCREENSHOT_MAX_BYTES = 512 * 1024;
const DASHBOARD_MAX_FILES = 400;
const DASHBOARD_MAX_BYTES = 4 * 1024 * 1024;
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The command line's flags: --input and --output, each taking the next argument. */
function flags(argv: string[]): { input: string | null; output: string | null } {
  let input: string | null = null;
  let output: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input' && i + 1 < argv.length) input = argv[++i]!;
    else if (argv[i] === '--output' && i + 1 < argv.length) output = argv[++i]!;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('usage: node main.ts [--input <snapshot.json|directory>] [--output <dir>]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return { input, output };
}

/**
 * The snapshot's origin as a plain label: the source string with any link and any
 * fetch timestamp stripped, so no output file carries a URL or a clock reading.
 */
function originLabel(source: string): string {
  const cleaned = source
    .replace(/https?:\/\/\S+/g, '')
    .replace(/,?\s*fetched.*$/i, '')
    .trim();
  return cleaned === '' ? 'snapshot' : cleaned;
}

/** One directory's regular files copied into `to`, dot-names skipped, names returned in order. */
function copyFiles(from: string, to: string): string[] {
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

function fail(message: string): never {
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(1);
}

function main(): void {
  const { input, output } = flags(process.argv.slice(2));
  const inputArg = input ?? '/input';
  const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
  if (!existsSync(inputFile)) fail(`no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input`);
  const outDir = output ?? process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

  const snapshot = readSnapshot(readFileSync(inputFile, 'utf8'));
  const { rows, payload, report } = assembleBoard({ ...snapshot, source: originLabel(snapshot.source) });
  const issue = boardIssue(rows, snapshot);
  if (issue !== null) fail(`the model wrote a board the gate refuses: ${issue}`);

  const dashDir = join(outDir, 'dashboard');
  const shotsDir = join(outDir, 'screenshots');
  mkdirSync(dashDir, { recursive: true });
  mkdirSync(shotsDir, { recursive: true });

  writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows })}\n`, 'utf8');
  writeFileSync(join(outDir, 'data.js'), payloadScript(payload), 'utf8');
  for (const name of ['index.html', 'app.css', 'app.js']) {
    copyFileSync(join(REPO, 'dashboard', name), join(dashDir, name));
  }
  writeFileSync(join(dashDir, 'report.md'), report, 'utf8');
  const shots = copyFiles(join(REPO, 'screenshots'), shotsDir);
  if (shots.length < 3 || shots.length > SCREENSHOT_MAX) {
    fail(`screenshots/ holds ${shots.length} images: hand in 3 or 4`);
  }
  for (const name of shots) {
    if (!IMAGE_NAME.test(name)) fail(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`);
  }

  const dossier = buildDossier(outDir, {
    text_max_bytes: TEXT_CAP_BYTES,
    screenshots: { max: SCREENSHOT_MAX, max_bytes: SCREENSHOT_MAX_BYTES },
    dashboard: { max_files: DASHBOARD_MAX_FILES, max_bytes: DASHBOARD_MAX_BYTES },
  });
  if (dossier.length > DOSSIER_CAP_BYTES) {
    fail(`dossier.json is ${dossier.length} bytes, over the gate's ${DOSSIER_CAP_BYTES}: shrink the screenshots`);
  }
  writeFileSync(join(outDir, 'dossier.json'), dossier);

  const textBytes = Buffer.byteLength(JSON.parse(Buffer.from(dossier).toString('utf8')).text, 'utf8');
  const top = rows[0]!;
  const bottom = rows[rows.length - 1]!;
  console.log(
    [
      `radar-5: ${snapshot.protocols.length} protocols, ${rows.length} rows, watchlist ${payload.coverage.watchlist_covered}/${payload.coverage.watchlist_size}`,
      `lanes: watchlist ${payload.coverage.lanes.watchlist}, early ${payload.coverage.lanes.early}, token-live ${payload.coverage.lanes['token-live']}, set-aside ${payload.coverage.lanes['set-aside']} (sum ${payload.coverage.lanes.watchlist + payload.coverage.lanes.early + payload.coverage.lanes['token-live'] + payload.coverage.lanes['set-aside']})`,
      `top ${top.slug} $${top.implied_value_usd.toLocaleString('en-US')}, bottom ${bottom.slug} $${bottom.implied_value_usd.toLocaleString('en-US')}`,
      `fit: intercept ${payload.fit.intercept}, slope ${payload.fit.slope}, size ${payload.fit.w_coef}, ${payload.fit.comp_count} comps; leave-one-out ${payload.validation.loo.final} vs flat ${payload.validation.loo.flat_median}; walk-forward ${payload.validation.walk_forward.final} vs flat ${payload.validation.walk_forward.flat}`,
      `odds: base rate ${payload.odds_validation.base_rate}; hierarchy kept: ${payload.odds_validation.hierarchy_kept}; loo logloss hierarchy ${payload.odds_validation.loo.hierarchy.log_loss} vs age-only ${payload.odds_validation.loo.age_only.log_loss}; chrono pooled ${payload.odds_validation.chrono_pooled.hierarchy.log_loss} vs ${payload.odds_validation.chrono_pooled.age_only.log_loss}`,
      `dossier: ${dossier.length} bytes, text ${textBytes} of ${TEXT_CAP_BYTES} bytes`,
    ].join('\n'),
  );
}

main();
