/**
 * Episode replay harness (POC). Feeds a captured transcript through the live
 * pipeline one cue at a time, as if it were airing, and writes one prompt
 * file per released segment for manual playground runs.
 *
 *   node lib/replay.ts cues/s51e1.jsonl
 *   node lib/replay.ts imported/s44e12.txt --context contexts/s44e12.json
 *
 * Input: cueServer JSONL, or plain text with one cue per line (timing is
 * synthesised from word count).
 *
 * Output per segment, numbered in release order, in replay-N/:
 *   {ep}p{n}.jsonl       line 1 state, line 2 questions, line 3+ pairing templates
 *   {ep}p{n}.meta.json   events, question set version, anchors, gaps, gates
 */

import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { join, basename, dirname } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { readCueFile } from "./input.ts";
import { cleanAll } from "./cues.ts";
import { auditAnchors } from "./scanner.ts";
import { createPipeline } from "./pipeline.ts";
import { withDefaults } from "./context.ts";
import { segmentsFor } from "../segments/index.ts";
import type { CancelEvent, CleanerStats, Context, Hit, Prompt, Segment } from "./types/index.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `usage: node lib/replay.ts <cues.jsonl|transcript.txt> [options]
   or: npm run replay -- <cues.jsonl|transcript.txt> [options]
  --episode NAME   output file prefix (default: input file name)
  --context FILE   season context JSON (default: contexts/{episode}.json)
  --lead    N      seconds to include before start anchor (default: 20)
  --tail    N      seconds to include after end anchor (default: 20)
  --audit          print every anchor match by segment type, then exit`;

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      episode: { type: "string" },
      context: { type: "string" },
      lead: { type: "string", default: "20" },
      tail: { type: "string", default: "20" },
      audit: { type: "boolean", default: false },
    },
  });
} catch (e) {
  fail((e as Error).message);
}
const { values: opts, positionals } = parsed;

if (positionals.length !== 1)
  fail(positionals.length ? `expected one input file, got: ${positionals.join(" ")}` : "missing input file");
const IN = positionals[0];
if (!existsSync(IN)) fail(`input file not found: ${IN}`);

const EPISODE = opts.episode ?? basename(IN).replace(/\.(jsonl|txt)$/, "");
const BUFFER = { lead: Number(opts.lead), tail: Number(opts.tail) };
if (!Number.isFinite(BUFFER.lead) || !Number.isFinite(BUFFER.tail)) fail("--lead and --tail must be numbers");

function loadContext(): Context {
  const explicit = opts.context !== undefined;
  const path = opts.context ?? join(ROOT, "contexts", `${EPISODE}.json`);
  if (!existsSync(path)) {
    if (explicit) {
      console.error(`context file not found: ${path}`);
      process.exit(2);
    }
    console.log(`no context at ${path} -- per-castaway and per-tribe questions omitted\n`);
    return withDefaults();
  }
  return withDefaults(JSON.parse(readFileSync(path, "utf8")));
}

const ctx = loadContext();
const defs = segmentsFor(ctx);
const raw = readCueFile(IN);
const at = (t: number) => `[${t.toFixed(0)}s]`;
const hitLine = (h: Hit) => `"${h.phrase}" ${h.score.toFixed(2)}  ${at(h.time)} ${h.text.slice(0, 70)}`;

function logStats(stats: CleanerStats) {
  console.log(`\nloaded ${stats.loaded} cues, ${stats.deduped} after scroll-repeat removal`);
  const { recap, preview } = stats;
  if (recap)
    console.log(
      `recap stripped: ${recap.cues} cues, ${recap.from.toFixed(0)}-${recap.to.toFixed(0)}s (closed by ${recap.closedBy})`
    );
  if (preview) console.log(`preview at ${preview.from.toFixed(0)}s, episode ended there`);
}

if (opts.audit) {
  const { cues, stats } = cleanAll(raw);
  logStats(stats);
  console.log("\nEvery anchor match in the file, by segment type. x = excluded.\n");
  for (const { id, hits } of auditAnchors(cues, defs)) {
    console.log(`### ${id}`);
    for (const h of hits)
      console.log(
        `  ${(h.kind.toUpperCase() + (h.excluded ? " x" : "")).padEnd(9)} ${at(h.cue.start)} "${h.phrase}" ${h.score.toFixed(2)} :: ${h.cue.text.slice(0, 70)}`
      );
    console.log("");
  }
  process.exit(0);
}

function nextReplayDir(baseDir = "."): string {
  const existing = readdirSync(baseDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => /^replay-(\d+)$/.exec(d.name))
    .filter((m) => m !== null)
    .map((m) => parseInt(m[1], 10));
  const dir = join(baseDir, `replay-${existing.length ? Math.max(...existing) + 1 : 1}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const replayDir = nextReplayDir();
let n = 0;
let cancelled = 0;

function onSegment(seg: Segment, prompt: Prompt) {
  n++;
  const file = join(replayDir, `${EPISODE}p${n}.jsonl`);
  writeFileSync(
    file,
    [
      JSON.stringify(prompt.state),
      JSON.stringify(prompt.questions),
      ...prompt.templates.map((t) => JSON.stringify(t)),
    ].join("\n") + "\n"
  );
  writeFileSync(
    join(replayDir, `${EPISODE}p${n}.meta.json`),
    JSON.stringify({ episode: EPISODE, ...prompt.meta }, null, 2) + "\n"
  );

  const { window, gaps, anchors } = prompt.meta;
  console.log(
    `p${n}  ${seg.def.id.padEnd(12)} ${seg.def.events.join(",").padEnd(30)} ` +
      `${seg.startTime.toFixed(0)}-${seg.endTime.toFixed(0)}s  ` +
      `${window.cues} cues, ${window.chars} chars, ${Object.keys(prompt.questions).length} questions` +
      (prompt.templates.length ? `, ${prompt.templates.length} template(s)` : "")
  );
  console.log(`     START   ${hitLine(seg.start)}`);
  if (seg.require) console.log(`     REQUIRE ${hitLine(seg.require)}`);
  console.log(`     CLOSED  by ${seg.closedBy}${seg.end ? `  "${seg.end.phrase}" ${seg.end.score.toFixed(2)}` : ""}`);
  console.log(`     LASTLINE ${anchors.lastLine.slice(0, 80)}`);
  if (seg.mergedFrom > 1) console.log(`     MERGED  ${seg.mergedFrom} candidates`);
  if (gaps.length) console.log(`     GAPS    ${gaps.map((g) => `${g.seconds}s at ${g.at}s`).join(", ")}`);
  console.log(`     -> ${file}`);
}

function onCancel(e: CancelEvent) {
  cancelled++;
  console.log(
    `  x  ${e.def.id.padEnd(12)} ${at(e.startTime)} "${e.start.phrase}" ${e.start.score.toFixed(2)} -- ${e.reason}`
  );
}

const pipeline = createPipeline({ defs, ctx, buffer: BUFFER, onSegment, onCancel });
for (const cue of raw) pipeline.push(cue);
pipeline.finish();

logStats(pipeline.stats);
console.log(`${n} segments released, ${cancelled} candidates cancelled`);
