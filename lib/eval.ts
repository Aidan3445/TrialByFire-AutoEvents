/**
 * Season eval: every episode transcript through the live pipeline, every
 * prompt through Jev (with follow-ups), every derivation scored against the
 * events the league recorded.
 *
 *   node lib/eval.ts imported/eval/s46
 *   node lib/eval.ts imported/eval/s46 --episodes 1,7 --concurrency 8
 *
 * Needs JEV_API_KEY in .env. Reads <dir>/context.json and <dir>/e{n}.txt.
 * Writes evals/<season>-<timestamp>/ with report.md, report.json, and per
 * episode e{n}/p{k}.{jsonl,meta.json,jev.json,followup.json,derived.json}.
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { readCueFile } from "./input.ts";
import { createPipeline } from "./pipeline.ts";
import { createJevClient } from "./jev.ts";
import { extract, type Extraction } from "./extract.ts";
import { checkEpisode } from "./derive.ts";
import { loadSeason } from "./season.ts";
import { NOT_SCANNED, exitsTogether, scoreEpisode, strict, totals, type EpisodeScore, type Predicted, type Row } from "./score.ts";
import { questionSetVersion } from "./prompt.ts";
import { segmentsFor, SEGMENTS } from "../segments/index.ts";
import type { Check, Prompt, Segment, TruthEvent } from "./types/index.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "usage: node lib/eval.ts <season-dir> [--episodes 1,2] [--concurrency 6]";
const PRICE_PER_MTOK = 0.042;

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: { episodes: { type: "string" }, concurrency: { type: "string", default: "6" } },
  });
} catch (e) {
  fail((e as Error).message);
}
const { values: opts, positionals } = parsed;
if (positionals.length !== 1) fail("expected one season folder");
const DIR = positionals[0];
const contextPath = join(DIR, "context.json");
if (!existsSync(contextPath)) fail(`no context.json in ${DIR}`);
const CONCURRENCY = Number(opts.concurrency);

const envPath = join(ROOT, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);
const apiKey = process.env.JEV_API_KEY;
if (!apiKey) fail("JEV_API_KEY not set (expected in .env)");

const season = loadSeason(contextPath);
const episodes = opts.episodes ? opts.episodes.split(",").map(Number) : season.episodes;
const tag = basename(DIR);
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const RUN = join(ROOT, "evals", `${tag}-${stamp}`);
mkdirSync(RUN, { recursive: true });
const jev = createJevClient({ apiKey });
const started = Date.now();

async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

const write = (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data, null, 2) + "\n");

interface EpisodeResult {
  episode: number;
  prompts: number;
  predicted: Predicted[];
  truth: TruthEvent[];
  strict: EpisodeScore;
  exits: EpisodeScore;
  checks: { prompt: string; check: Check }[];
  errors: { prompt: string; error: string }[];
}

async function runEpisode(ep: number): Promise<EpisodeResult | null> {
  const transcript = join(DIR, `e${ep}.txt`);
  if (!existsSync(transcript)) {
    console.log(`e${ep}: no transcript, skipped`);
    return null;
  }
  const ctx = season.contextFor(ep);
  const defs = segmentsFor(ctx);
  const dir = join(RUN, `e${ep}`);
  mkdirSync(dir, { recursive: true });
  write(join(dir, "context.json"), ctx);

  const found: { seg: Segment; prompt: Prompt }[] = [];
  const pipeline = createPipeline({ defs, ctx, onSegment: (seg, prompt) => found.push({ seg, prompt }) });
  for (const cue of readCueFile(transcript)) pipeline.push(cue);
  pipeline.finish();

  const errors: EpisodeResult["errors"] = [];
  const results = await pool(found.map((f, i) => ({ ...f, id: `p${i + 1}` })), CONCURRENCY, async ({ seg, prompt, id }) => {
    const base = join(dir, id);
    writeFileSync(
      `${base}.jsonl`,
      [prompt.state, prompt.questions, ...prompt.templates].map((x) => JSON.stringify(x)).join("\n") + "\n"
    );
    write(`${base}.meta.json`, { episode: `${tag}e${ep}`, ...prompt.meta });
    try {
      const x: Extraction = await extract(seg.def, prompt, ctx, jev);
      write(`${base}.jev.json`, x.main);
      if (x.followup) write(`${base}.followup.json`, x.followup);
      write(`${base}.derived.json`, x.derivation);
      return { id, x };
    } catch (e) {
      errors.push({ prompt: id, error: (e as Error).message });
      return { id, x: null };
    }
  });

  const predicted: Predicted[] = results.flatMap(({ id, x }) => x?.derivation.events.map((e) => ({ ...e, prompt: id })) ?? []);
  const derivations = results.flatMap(({ x }) => (x ? [x.derivation] : []));
  const checks = [
    ...results.flatMap(({ id, x }) => x?.derivation.checks.map((check) => ({ prompt: id, check })) ?? []),
    ...checkEpisode(derivations).map((check) => ({ prompt: "episode", check })),
  ];
  const truth = season.truthFor(ep);
  const result: EpisodeResult = {
    episode: ep,
    prompts: found.length,
    predicted,
    truth,
    strict: scoreEpisode(ep, truth, predicted, strict),
    exits: scoreEpisode(ep, truth, predicted, exitsTogether),
    checks,
    errors,
  };
  write(join(dir, "events.json"), { episode: ep, predicted, truth, score: result.strict, checks });
  const sum = (rows: Row[], k: keyof Row) => rows.reduce((n, r) => n + (r[k] as number), 0);
  console.log(
    `e${ep}: ${found.length} prompts, ${predicted.length} draft events | ` +
      `hits ${sum(result.strict.rows, "hits")}/${sum(result.strict.rows, "truth")}, ` +
      `false alarms ${sum(result.strict.rows, "falseAlarms")}` +
      (errors.length ? ` | ${errors.length} errors` : "")
  );
  return result;
}

// Episodes run one after another; prompts within an episode run in parallel
const results: EpisodeResult[] = [];
for (const ep of episodes) {
  const r = await runEpisode(ep);
  if (r) results.push(r);
}

// ---------------------------------------------------------------------------
// Report

const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "–");
function table(rows: Row[]): string {
  const lines = [
    "| event | truth | predicted | hits | misses (assisted) | false alarms | empty cards | recall | recall incl. assisted | precision |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  const all: Row = rows.reduce(
    (a, r) => ({
      ...a,
      truth: a.truth + r.truth,
      predicted: a.predicted + r.predicted,
      hits: a.hits + r.hits,
      misses: a.misses + r.misses,
      falseAlarms: a.falseAlarms + r.falseAlarms,
      assisted: a.assisted + r.assisted,
      empty: a.empty + r.empty,
    }),
    { eventName: "**all**", truth: 0, predicted: 0, hits: 0, misses: 0, falseAlarms: 0, assisted: 0, empty: 0 }
  );
  for (const r of [...rows, all])
    lines.push(
      `| ${r.eventName} | ${r.truth} | ${r.predicted} | ${r.hits} | ${r.misses} (${r.assisted}) | ${r.falseAlarms} | ${r.empty} | ` +
        `${pct(r.hits, r.truth)} | ${pct(r.hits + r.assisted, r.truth)} | ${pct(r.hits, r.predicted)} |`
    );
  return lines.join("\n");
}

const strictRows = totals(results.map((r) => r.strict));
const exitRows = totals(results.map((r) => r.exits)).filter((r) => r.eventName === "exit");
const cost = (jev.usage.inputTokens / 1e6) * PRICE_PER_MTOK;
const minutes = ((Date.now() - started) / 60000).toFixed(1);
const notScanned = results.flatMap((r) => r.truth.filter((e) => NOT_SCANNED.includes(e.eventName)));
const notes = results.flatMap((r) => r.predicted.filter((e) => e.eventName === "otherNotes"));
const failed = results.flatMap((r) => r.checks.filter((c) => c.check.status !== "pass").map((c) => ({ ep: r.episode, ...c })));
const errors = results.flatMap((r) => r.errors.map((e) => ({ ep: r.episode, ...e })));

const md = [
  `# ${season.name} eval`,
  "",
  `Run ${stamp} · ${results.length} episodes · ${results.reduce((n, r) => n + r.prompts, 0)} prompts · ` +
    `${jev.usage.requests} Jev requests (${jev.usage.retries} retries) · ` +
    `${jev.usage.inputTokens.toLocaleString()} input tokens (~$${cost.toFixed(3)}) · ${minutes} min`,
  "",
  "Question set versions: " + SEGMENTS.map((d) => `\`${questionSetVersion(d)}\``).join(", "),
  "",
  "Pairs are (event, castaway or tribe). **Assisted** misses were offered on the card as a suggestion, so one tap fixes them. **Empty cards** are drafts with no confident reference.",
  "",
  "## Scored events",
  "",
  table(strictRows),
  "",
  "With elim and noVoteExit counted as one exit (the league files fire-making losses as elim):",
  "",
  table(exitRows),
  "",
  `Not scanned (derived from app state): ${notScanned.length} truth events (${NOT_SCANNED.join(", ")}).`,
  `Unscored drafts: ${notes.length} otherNotes (the league doesn't record notes).`,
  errors.length ? `\n**Errors:** ${errors.map((e) => `e${e.ep} ${e.prompt}: ${e.error}`).join("; ")}` : "",
  "",
  "## Per episode",
  "",
  ...results.flatMap((r) => [
    `### e${r.episode}`,
    "",
    r.strict.misses.length
      ? `Misses: ${r.strict.misses.map((m) => `${m.eventName} ${m.name}${m.assisted ? " (assisted)" : ""}`).join(", ")}`
      : "Misses: none",
    "",
    r.strict.falseAlarms.length
      ? `False alarms: ${r.strict.falseAlarms.map((f) => `${f.eventName} ${f.name} [${f.prompts.join(",")}]`).join(", ")}`
      : "False alarms: none",
    "",
  ]),
  "## Failed checks",
  "",
  failed.length ? failed.map((c) => `- e${c.ep} ${c.prompt} **${c.check.status}** ${c.check.name}: ${c.check.detail}`).join("\n") : "none",
  "",
].join("\n");

writeFileSync(join(RUN, "report.md"), md);
write(join(RUN, "report.json"), {
  season: season.name,
  run: stamp,
  usage: jev.usage,
  cost,
  totals: strictRows,
  exits: exitRows,
  episodes: results.map(({ predicted: _p, truth: _t, ...rest }) => rest),
});
console.log(`\n${table(strictRows)}\n\n${table(exitRows)}\n\nusage ${JSON.stringify(jev.usage)} ~$${cost.toFixed(3)}, ${minutes} min`);
console.log(`-> ${join(RUN, "report.md")}`);
