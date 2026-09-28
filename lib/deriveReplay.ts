/**
 * Derivation harness (POC). Reads a replay folder where Jev's playground
 * responses have been saved next to the prompts, and writes draft events.
 *
 *   node lib/deriveReplay.ts replay-8
 *
 * Reads per segment:
 *   {ep}p{n}.meta.json       from replay
 *   {ep}p{n}jev.json         Jev's response to line 2 of {ep}p{n}.jsonl
 *   {ep}p{n}followup.json    optional: { qSet, response } for filled templates
 *
 * Writes per segment:
 *   {ep}p{n}.derived.json          draft events, checks, raw answers
 *   {ep}p{n}.followup.questions.json  questions to run next, when needed
 * and {ep}.events.json with every draft event in the folder.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { checkEpisode, deriveSegment } from "./derive.ts";
import { questionSetVersion } from "./prompt.ts";
import { withDefaults } from "./context.ts";
import { segmentsFor } from "../segments/index.ts";
import type { Answers, Check, Context, Derivation, DraftEvent, FollowupRun, JevResponse, PromptMeta } from "./types/index.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "usage: node lib/deriveReplay.ts <replay-dir> [--context FILE]";

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

let parsed;
try {
  parsed = parseArgs({ allowPositionals: true, options: { context: { type: "string" } } });
} catch (e) {
  fail((e as Error).message);
}
const { values: opts, positionals } = parsed;
if (positionals.length !== 1) fail("expected one replay folder");
const DIR = positionals[0];
if (!existsSync(DIR)) fail(`folder not found: ${DIR}`);

type Meta = PromptMeta & { episode: string };
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8"));

const metas = readdirSync(DIR)
  .map((f) => /^(.+)p(\d+)\.meta\.json$/.exec(f))
  .filter((m) => m !== null)
  .map((m) => ({ prefix: `${m[1]}p${m[2]}`, n: Number(m[2]), meta: readJson<Meta>(join(DIR, m[0])) }))
  .sort((a, b) => a.n - b.n);
if (!metas.length) fail(`no *.meta.json files in ${DIR}`);

const episode = metas[0].meta.episode;
function loadContext(): Context {
  const path = opts.context ?? join(ROOT, "contexts", `${episode}.json`);
  if (!existsSync(path)) fail(`context file not found: ${path}`);
  return withDefaults(JSON.parse(readFileSync(path, "utf8")));
}
const ctx = loadContext();
const defs = new Map(segmentsFor(ctx).map((d) => [d.id, d]));

const mark = { pass: "ok  ", warn: "warn", fail: "FAIL" };
const logChecks = (checks: Check[]) => {
  for (const c of checks) if (c.status !== "pass" || c.name === "canaries") console.log(`      ${mark[c.status]} ${c.name}: ${c.detail}`);
};
const refList = (e: DraftEvent) =>
  e.references.map((x) => (x.type === "Tribe" ? `[${x.name}]` : `${x.name}(${e.confidence[`ref:${x.name}`] ?? "?"})`)).join(" ");

const results: Derivation[] = [];
const allEvents: object[] = [];

for (const { prefix, n, meta } of metas) {
  const def = defs.get(meta.segment);
  const jevPath = join(DIR, `${prefix}jev.json`);
  if (!def) {
    console.log(`p${n}  ${meta.segment}: unknown segment type`);
    continue;
  }
  if (!existsSync(jevPath)) {
    console.log(`p${n}  ${meta.segment}: no Jev response yet (${prefix}jev.json)`);
    continue;
  }
  const jev = readJson<JevResponse>(jevPath);
  const answers: Answers = { ...jev.answers };
  const followupPath = join(DIR, `${prefix}followup.json`);
  const followup = existsSync(followupPath) ? readJson<FollowupRun>(followupPath) : null;
  if (followup) Object.assign(answers, followup.response.answers);

  const d = deriveSegment(def, ctx, answers);
  results.push(d);
  const source = {
    episode,
    segment: meta.segment,
    prompt: prefix,
    segmentStart: meta.window.start,
    segmentEnd: meta.window.end,
    questionSetVersion: meta.questionSetVersion,
  };
  writeFileSync(
    join(DIR, `${prefix}.derived.json`),
    JSON.stringify({ ...source, ...d, rawAnswers: { main: jev, followup: followup?.response ?? null } }, null, 2) + "\n"
  );
  for (const e of d.events) allEvents.push({ ...source, ...e });

  const stale = meta.questionSetVersion !== questionSetVersion(def);
  console.log(
    `p${n}  ${meta.segment.padEnd(12)} detected ${d.detected ?? "?"}${d.events.length ? "" : "  -> nothing"}` +
      (stale ? `  [questions changed since prompt: ${meta.questionSetVersion} -> ${questionSetVersion(def)}]` : "")
  );
  for (const e of d.events) {
    console.log(`      ${e.eventName.padEnd(12)} ${(e.label ?? "(no label)").padEnd(30)} ${refList(e) || "(no refs)"}`);
    for (const note of e.notes) console.log(`        note: ${note}`);
    for (const u of e.unresolved)
      console.log(
        `        ask:  ${u.field} -- ${u.reason}` +
          (u.options?.length
            ? `  [${u.options.map((o) => (o.confidence == null ? o.value : `${o.value} ${o.confidence}`)).join(", ")}]`
            : "")
      );
  }
  logChecks(d.checks);
  if (d.followups) {
    const file = join(DIR, `${prefix}.followup.questions.json`);
    writeFileSync(file, JSON.stringify(d.followups) + "\n");
    console.log(`      follow-up: ${Object.keys(d.followups).join(", ")} -> ${file}`);
  }
}

const episodeChecks = checkEpisode(results);
console.log(`\n${episode}: ${allEvents.length} draft events`);
for (const c of episodeChecks) console.log(`  ${mark[c.status]} ${c.name}: ${c.detail}`);
const out = join(DIR, `${episode}.events.json`);
writeFileSync(out, JSON.stringify({ episode, checks: episodeChecks, events: allEvents }, null, 2) + "\n");
console.log(`-> ${out}`);
