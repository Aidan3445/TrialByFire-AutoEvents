/**
 * Season eval: every episode transcript through the live pipeline, every
 * prompt through Jev (with follow-ups), every derivation scored against the
 * events the league recorded.
 *
 *   node lib/eval.ts imported/eval/s46
 *   node lib/eval.ts imported/eval/s46 --episodes 1,7 --concurrency 8
 *   node lib/eval.ts --rescore evals/s46-20260928-203616   (no Jev calls)
 *
 * Needs JEV_API_KEY in .env. Reads <dir>/context.json and <dir>/e{n}.txt.
 * Writes evals/<season>-<timestamp>/ with report.md, report.json, and per
 * episode e{n}/p{k}.{jsonl,meta.json,jev.json,followup.json,derived.json}
 * plus e{n}/events.json, which --rescore rebuilds the report from.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { readCueFile } from "./input.ts";
import { createPipeline } from "./pipeline.ts";
import { createJevClient, type JevUsage } from "./jev.ts";
import { extract, type Extraction } from "./extract.ts";
import { checkEpisode } from "./derive.ts";
import { loadSeason } from "./season.ts";
import {
  NOT_SCANNED,
  exitsTogether,
  scoreEpisode,
  scoreTriggers,
  strict,
  totals,
  type EpisodeScore,
  type Predicted,
  type Row,
} from "./score.ts";
import { questionSetVersion } from "./prompt.ts";
import { segmentsFor, SEGMENTS } from "../segments/index.ts";
import type { Check, Prompt, Segment, TruthEvent } from "./types/index.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = `usage: node lib/eval.ts <season-dir> [--episodes 1,2] [--concurrency 6]
   or: node lib/eval.ts --rescore <run-dir>`;
const PRICE_PER_MTOK = 0.042;

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      episodes: { type: "string" },
      concurrency: { type: "string", default: "6" },
      rescore: { type: "string" },
    },
  });
} catch (e) {
  fail((e as Error).message);
}
const { values: opts, positionals } = parsed;

const write = (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data, null, 2) + "\n");

interface EpisodeResult {
  episode: number;
  prompts: number;
  predicted: Predicted[];
  truth: TruthEvent[];
  triggers: EpisodeScore;
  triggerExits: EpisodeScore;
  strict: EpisodeScore;
  exits: EpisodeScore;
  checks: { prompt: string; check: Check }[];
  errors: { prompt: string; error: string }[];
}

type Saved = Pick<EpisodeResult, "episode" | "prompts" | "predicted" | "truth" | "checks" | "errors">;

function score(s: Saved): EpisodeResult {
  return {
    ...s,
    triggers: scoreTriggers(s.episode, s.truth, s.predicted, strict),
    triggerExits: scoreTriggers(s.episode, s.truth, s.predicted, exitsTogether),
    strict: scoreEpisode(s.episode, s.truth, s.predicted, strict),
    exits: scoreEpisode(s.episode, s.truth, s.predicted, exitsTogether),
  };
}

// ---------------------------------------------------------------------------
// Running

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

async function run(DIR: string): Promise<{ run: string; title: string; results: EpisodeResult[]; info: string }> {
  const contextPath = join(DIR, "context.json");
  if (!existsSync(contextPath)) fail(`no context.json in ${DIR}`);
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
  const concurrency = Number(opts.concurrency);

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

    // Catches a transcript from the wrong season or episode before spending calls on it
    const text = readFileSync(transcript, "utf8").toLowerCase();
    const named = ctx.cast.filter((n) => new RegExp(`\\b${n.toLowerCase().replace(/[^a-z0-9 ]/g, ".")}\\b`).test(text));
    const mismatch = named.length < ctx.cast.length / 2;
    if (mismatch)
      console.log(`e${ep}: WARNING only ${named.length}/${ctx.cast.length} cast names appear in the transcript -- wrong file?`);

    const found: { seg: Segment; prompt: Prompt }[] = [];
    const pipeline = createPipeline({ defs, ctx, onSegment: (seg, prompt) => found.push({ seg, prompt }) });
    for (const cue of readCueFile(transcript)) pipeline.push(cue);
    pipeline.finish();

    const errors: EpisodeResult["errors"] = [];
    const results = await pool(found.map((f, i) => ({ ...f, id: `p${i + 1}` })), concurrency, async ({ seg, prompt, id }) => {
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
    if (mismatch) errors.push({ prompt: "transcript", error: `only ${named.length}/${ctx.cast.length} cast names appear -- wrong file?` });
    const saved: Saved = { episode: ep, prompts: found.length, predicted, truth: season.truthFor(ep), checks, errors };
    write(join(dir, "events.json"), saved);
    const result = score(saved);
    const sum = (rows: Row[], k: keyof Row) => rows.reduce((n, r) => n + (r[k] as number), 0);
    console.log(
      `e${ep}: ${found.length} prompts, ${predicted.length} drafts | ` +
      `triggers ${sum(result.triggers.rows, "hits")}/${sum(result.triggers.rows, "truth")}, ` +
      `members ${sum(result.strict.rows, "hits")}/${sum(result.strict.rows, "truth")}` +
      (errors.length ? ` | ${errors.length} errors` : "")
    );
    return result;
  }

  const results: EpisodeResult[] = [];
  for (const ep of episodes) {
    const r = await runEpisode(ep);
    if (r) results.push(r);
  }
  const u: JevUsage = jev.usage;
  const info =
    `${results.reduce((n, r) => n + r.prompts, 0)} prompts · ${u.requests} Jev requests (${u.retries} retries) · ` +
    `${u.inputTokens.toLocaleString()} input tokens (~$${((u.inputTokens / 1e6) * PRICE_PER_MTOK).toFixed(3)}) · ` +
    `${((Date.now() - started) / 60000).toFixed(1)} min`;
  write(join(RUN, "run.json"), { season: season.name, source: DIR, stamp, usage: u });
  return { run: RUN, title: season.name, results, info };
}

function rescore(RUN: string): { run: string; title: string; results: EpisodeResult[]; info: string } {
  if (!existsSync(RUN)) fail(`run folder not found: ${RUN}`);
  const results = readdirSync(RUN)
    .filter((d) => /^e\d+$/.test(d) && existsSync(join(RUN, d, "events.json")))
    .map((d) => {
      const s = JSON.parse(readFileSync(join(RUN, d, "events.json"), "utf8"));
      const prompts = readdirSync(join(RUN, d)).filter((f) => f.endsWith(".meta.json")).length;
      return score({ episode: s.episode, prompts, predicted: s.predicted, truth: s.truth, checks: s.checks ?? [], errors: s.errors ?? [] });
    })
    .sort((a, b) => a.episode - b.episode);
  const runInfo = existsSync(join(RUN, "run.json")) ? JSON.parse(readFileSync(join(RUN, "run.json"), "utf8")) : null;
  return {
    run: RUN,
    title: runInfo?.season ?? basename(RUN).replace(/-\d{8}-\d{6}$/, ""),
    results,
    info: `rescored from saved results · ${results.reduce((n, r) => n + r.prompts, 0)} prompts`,
  };
}

// ---------------------------------------------------------------------------
// Report

const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "–");
const sumRows = (rows: Row[], eventName: string): Row =>
  rows.reduce(
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
    { eventName, truth: 0, predicted: 0, hits: 0, misses: 0, falseAlarms: 0, assisted: 0, empty: 0 }
  );

function triggerTable(rows: Row[]): string {
  const lines = ["| event | recorded | drafted | caught | missed | extra | recall | precision |", "|---|---|---|---|---|---|---|---|"];
  for (const r of [...rows, sumRows(rows, "**all**")])
    lines.push(
      `| ${r.eventName} | ${r.truth} | ${r.predicted} | ${r.hits} | ${r.misses} | ${r.falseAlarms} | ${pct(r.hits, r.truth)} | ${pct(r.hits, r.predicted)} |`
    );
  return lines.join("\n");
}

function pairTable(rows: Row[]): string {
  const lines = [
    "| event | truth | predicted | hits | misses (assisted) | false alarms | empty cards | recall | recall incl. assisted | precision |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of [...rows, sumRows(rows, "**all**")])
    lines.push(
      `| ${r.eventName} | ${r.truth} | ${r.predicted} | ${r.hits} | ${r.misses} (${r.assisted}) | ${r.falseAlarms} | ${r.empty} | ` +
      `${pct(r.hits, r.truth)} | ${pct(r.hits + r.assisted, r.truth)} | ${pct(r.hits, r.predicted)} |`
    );
  return lines.join("\n");
}

function report({ run, title, results, info }: { run: string; title: string; results: EpisodeResult[]; info: string }) {
  const triggerRows = totals(results.map((r) => r.triggers));
  const triggerExit = totals(results.map((r) => r.triggerExits)).filter((r) => r.eventName === "exit");
  const pairRows = totals(results.map((r) => r.strict));
  const pairExit = totals(results.map((r) => r.exits)).filter((r) => r.eventName === "exit");
  const notScanned = results.flatMap((r) => r.truth.filter((e) => NOT_SCANNED.includes(e.eventName)));
  const notes = results.flatMap((r) => r.predicted.filter((e) => e.eventName === "otherNotes"));
  const recordedNotes = results.flatMap((r) => r.truth.filter((e) => e.eventName === "otherNotes"));
  const failed = results.flatMap((r) => r.checks.filter((c) => c.check.status !== "pass").map((c) => ({ ep: r.episode, ...c })));
  const errors = results.flatMap((r) => r.errors.map((e) => ({ ep: r.episode, ...e })));
  const byEpisode = (list: { eventName: string; name: string }[]) =>
    Object.entries(
      list.reduce<Record<string, number>>((m, x) => ((m[x.eventName] = (m[x.eventName] ?? 0) + 1), m), {})
    )
      .map(([k, n]) => (n > 1 ? `${k} ×${n}` : k))
      .join(", ");

  const md = [
    `# ${title} eval`,
    "",
    `${results.length} episodes · ${info}`,
    "",
    "Question set versions: " + SEGMENTS.map((d) => `\`${questionSetVersion(d)}\``).join(", "),
    "",
    "## Triggers",
    "",
    "Was a card of the right type drafted in the episode, whoever it names. **Extra** cards are duplicates or false triggers.",
    "",
    triggerTable(triggerRows),
    "",
    "With elim and noVoteExit counted as one exit:",
    "",
    triggerTable(triggerExit),
    "",
    "## Members",
    "",
    "Pairs are (event, castaway or tribe). **Assisted** misses were offered on the card as a suggestion. **Empty cards** have no confident reference.",
    "",
    pairTable(pairRows),
    "",
    pairTable(pairExit),
    "",
    `Not scanned (derived from app state): ${notScanned.length} recorded events (${NOT_SCANNED.join(", ")}).`,
    `Unscored: ${notes.length} otherNotes drafted, ${recordedNotes.length} recorded.`,
    errors.length ? `\n**Errors:** ${errors.map((e) => `e${e.ep} ${e.prompt}: ${e.error}`).join("; ")}` : "",
    "",
    "## Per episode",
    "",
    ...results.flatMap((r) => [
      `### e${r.episode}`,
      "",
      `Missed triggers: ${byEpisode(r.triggers.misses) || "none"}`,
      "",
      `Extra cards: ${r.triggers.falseAlarms.map((f) => `${f.eventName} ${f.name} [${f.prompts.join(",")}]`).join(", ") || "none"}`,
      "",
      `Member misses: ${r.strict.misses.map((m) => `${m.eventName} ${m.name}${m.assisted ? " (assisted)" : ""}`).join(", ") || "none"}`,
      "",
      `Member false alarms: ${r.strict.falseAlarms.map((f) => `${f.eventName} ${f.name} [${f.prompts.join(",")}]`).join(", ") || "none"}`,
      "",
    ]),
    "## Failed checks",
    "",
    failed.length ? failed.map((c) => `- e${c.ep} ${c.prompt} **${c.check.status}** ${c.check.name}: ${c.check.detail}`).join("\n") : "none",
    "",
  ].join("\n");

  writeFileSync(join(run, "report.md"), md);
  write(join(run, "report.json"), {
    season: title,
    triggers: triggerRows,
    triggerExits: triggerExit,
    members: pairRows,
    memberExits: pairExit,
    episodes: results.map(({ predicted: _p, truth: _t, ...rest }) => rest),
  });
  console.log(`\n${triggerTable(triggerRows)}\n\n${triggerTable(triggerExit)}\n\n${info}\n-> ${join(run, "report.md")}`);
}

if (opts.rescore) {
  if (positionals.length) fail("--rescore takes a run folder, not a season folder");
  report(rescore(opts.rescore));
} else {
  if (positionals.length !== 1) fail("expected one season folder");
  report(await run(positionals[0]));
}
