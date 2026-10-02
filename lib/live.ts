/**
 * Live capture of Survivor captions, with Jev analysis and alerts.
 *
 *   node lib/cueServer.ts --out cues/s51e2.jsonl        (terminal 1)
 *   node lib/live.ts cues/s51e2.jsonl --notify          (terminal 2)
 *   node lib/live.ts cues/s51e2.jsonl --once            (scan a finished capture)
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "fs";
import { createServer } from "http";
import { basename, dirname, join } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { parseCueLine } from "./input.ts";
import { createPipeline } from "./pipeline.ts";
import { createJevClient } from "./jev.ts";
import { extract } from "./extract.ts";
import { withDefaults } from "./context.ts";
import { segmentsFor } from "../segments/index.ts";
import type { Cue, Derivation, DraftEvent, Prompt, ScanEvent, Segment } from "./types/index.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = `usage: node lib/live.ts <cues.jsonl> [options]
  <cues.jsonl>     the file cueServer is writing (--out); it may not exist yet
  --context FILE   episode context (default: contexts/{file name}.json)
  --title "TEXT"   episode title for spokeEpTitle detection (overrides the context file)
  --once           scan the file as it is now, then exit (no alerts endpoint)
  --fresh          start a new log folder instead of resuming the last one
  --port N         alerts endpoint for the extension (default: 8001)`;

// How long to keep segments open during interruptions 
const GAP_KEEP_S = 30;
// Ad breaks leave shorter silences; only call out holes this long
const GAP_REPORT_S = 120;
const STALL_WARN_S = 60;
const TAIL_S = 20;

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      context: { type: "string" },
      title: { type: "string" },
      notify: { type: "boolean", default: false },
      once: { type: "boolean", default: false },
      fresh: { type: "boolean", default: false },
      port: { type: "string", default: "8001" },
    },
  });
} catch (e) {
  fail((e as Error).message);
}
const { values: opts, positionals } = parsed;
if (positionals.length !== 1) fail("expected the cue file cueServer is writing");
const CUE_FILE = positionals[0];
const EPISODE = basename(CUE_FILE).replace(/\.jsonl$/, "");
if (opts.once && !existsSync(CUE_FILE)) fail(`cue file not found: ${CUE_FILE}`);

const envPath = join(ROOT, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);
if (!process.env.JEV_API_KEY) fail("JEV_API_KEY not set (expected in .env)");

const contextPath = opts.context ?? join(ROOT, "contexts", `${EPISODE}.json`);
if (!existsSync(contextPath)) fail(`context file not found: ${contextPath}`);
const fileCtx = withDefaults(JSON.parse(readFileSync(contextPath, "utf8")));
const ctx = opts.title ? { ...fileCtx, title: opts.title } : fileCtx;
const defs = segmentsFor(ctx);
const jev = createJevClient({ apiKey: process.env.JEV_API_KEY });

// Resume the latest folder for this episode so a restart reuses saved answers
const LIVE = join(ROOT, "live");
mkdirSync(LIVE, { recursive: true });
const previous = readdirSync(LIVE)
  .filter((d) => d.startsWith(`${EPISODE}-`))
  .sort()
  .at(-1);
const resuming = Boolean(previous && !opts.fresh);
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const RUN = join(LIVE, resuming ? previous! : `${EPISODE}-${stamp}`);
mkdirSync(RUN, { recursive: true });
// These are rebuilt from the cue file on every start
for (const f of ["alerts.jsonl", "cancelled.jsonl", "trace.log"]) writeFileSync(join(RUN, f), "");

const write = (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
const log = (file: string, data: unknown) => appendFileSync(join(RUN, file), JSON.stringify(data) + "\n");
const clock = () => new Date().toLocaleTimeString([], { hour12: false });
const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, "0")}`;
function say(line: string) {
  const out = `[${clock()}] ${line}`;
  console.log(out);
  appendFileSync(join(RUN, "trace.log"), out + "\n");
}


interface Alert {
  id: number;
  at: string;
  prompt: string;
  segment: string;
  airedAt: string;
  eventName: string;
  label: string | null;
  references: string[];
  confidence: number | null;
  asks: string[];
  notes: string[];
  saved: boolean;
}

const alerts: Alert[] = [];
const RUN_ID = stamp;

function raise(prompt: string, seg: Segment, e: DraftEvent, saved: boolean) {
  const alert: Alert = {
    id: alerts.length + 1,
    at: new Date().toISOString(),
    prompt,
    segment: seg.def.id,
    airedAt: mmss(seg.startTime),
    eventName: e.eventName,
    label: e.label,
    references: e.references.map((r) => r.name),
    confidence: e.confidence.event ?? null,
    asks: e.unresolved.map((u) => u.field),
    notes: e.notes,
    saved,
  };
  alerts.push(alert);
  log("alerts.jsonl", alert);
  const who = alert.references.join(", ") || "?";
  say(
    `EVENT   ${e.eventName.padEnd(12)} ${(e.label ?? "").padEnd(28)} ${who}` +
    (alert.confidence != null ? `  (${alert.confidence})` : "") +
    (alert.asks.length ? `  asks: ${alert.asks.join(", ")}` : "") +
    `  [${prompt}${saved ? ", saved" : ""}]`
  );
  for (const n of e.notes) say(`        ${n}`);
}


function onTrace(e: ScanEvent) {
  if (e.type === "open") {
    const { def } = e;
    const how = def.require
      ? `needs "${def.require.slice(0, 3).map((p) => p.text).join('" / "')}"... within ${mmss(def.maxSpan)}`
      : `confirmed by its trigger; closes on ${def.end ? "an end anchor or " : ""}${mmss(def.maxSpan)} cap`;
    say(`OPEN    ${def.id.padEnd(12)} at ${mmss(e.startTime)}  "${e.start.phrase}" ${e.start.score}  -- ${how}`);
  } else if (e.type === "confirm") {
    say(
      `CONFIRM ${e.def.id.padEnd(12)} opened ${mmss(e.startTime)}  "${e.require.phrase}" at ${mmss(e.require.time)}` +
      (e.absorbed ? `, folded in ${e.absorbed} later candidate(s)` : "")
    );
  } else if (e.type === "segment") {
    const s = e.segment;
    say(
      `CLOSE   ${s.def.id.padEnd(12)} ${mmss(s.startTime)}-${mmss(s.endTime)} by ${s.closedBy}` +
      (s.end ? ` "${s.end.phrase}"` : "") +
      (s.mergedFrom > 1 ? `, ${s.mergedFrom} candidates merged` : "") +
      ` -- asking Jev after ${TAIL_S}s tail`
    );
  } else {
    say(`CANCEL  ${e.def.id.padEnd(12)} opened ${mmss(e.startTime)} "${e.start.phrase}" -- ${e.reason}`);
    log("cancelled.jsonl", { segment: e.def.id, startTime: e.startTime, start: e.start, reason: e.reason });
  }
}


let n = 0;
let cues = 0;
let finished = false;
const inflight = new Set<Promise<void>>();

function report(id: string, seg: Segment, d: Derivation, saved: boolean) {
  if (!d.events.length) say(`RESULT  ${seg.def.id.padEnd(12)} [${id}] nothing: Jev says no (detected ${d.detected})`);
  for (const e of d.events) raise(id, seg, e, saved);
  for (const c of d.checks.filter((c) => c.status !== "pass")) say(`        check ${c.status}: ${c.name} -- ${c.detail}`);
}

function onSegment(seg: Segment, prompt: Prompt) {
  const id = `p${++n}`;
  const base = join(RUN, id);
  const meta = JSON.stringify({ episode: EPISODE, ...prompt.meta }, null, 2) + "\n";
  // Same segment as a previous run of this episode: reuse its answers
  if (resuming && existsSync(`${base}.derived.json`) && existsSync(`${base}.meta.json`) && readFileSync(`${base}.meta.json`, "utf8") === meta) {
    report(id, seg, JSON.parse(readFileSync(`${base}.derived.json`, "utf8")), true);
    return;
  }
  writeFileSync(`${base}.jsonl`, [prompt.state, prompt.questions, ...prompt.templates].map((x) => JSON.stringify(x)).join("\n") + "\n");
  writeFileSync(`${base}.meta.json`, meta);
  say(`ASK     ${seg.def.id.padEnd(12)} [${id}] ${Object.keys(prompt.questions).length} questions`);
  const job = extract(seg.def, prompt, ctx, jev)
    .then((x) => {
      write(`${base}.jev.json`, x.main);
      if (x.followup) write(`${base}.followup.json`, x.followup);
      write(`${base}.derived.json`, x.derivation);
      if (x.followup) say(`        [${id}] follow-up: ${Object.keys(x.followup.qSet).join(", ")}`);
      report(id, seg, x.derivation, false);
    })
    .catch((e) => {
      say(`ERROR   ${seg.def.id.padEnd(12)} [${id}] ${(e as Error).message}`);
      log("errors.jsonl", { prompt: id, error: (e as Error).message });
    });
  inflight.add(job);
  job.finally(() => inflight.delete(job));
}

const pipeline = createPipeline({ defs, ctx, buffer: { lead: 20, tail: TAIL_S }, onSegment, onTrace });

// Track gaps in the cue and remove them from the timeline
let wall0: number | null = null;
let lastWall: number | null = null;
let squeezed = 0;
const gaps: { at: string; seconds: number }[] = [];

function onTimeline(cue: Cue, wall: number | undefined): Cue {
  if (wall == null) return cue;
  wall0 ??= wall;
  const gap = lastWall == null ? 0 : Math.max(0, wall - lastWall);
  if (gap > GAP_KEEP_S) squeezed += gap - GAP_KEEP_S;
  lastWall = Math.max(lastWall ?? wall, wall);
  const start = lastWall - wall0 - squeezed;
  if (gap > GAP_REPORT_S) {
    gaps.push({ at: mmss(start), seconds: Math.round(gap) });
    say(`GAP     ${Math.round(gap)}s with no captions before ${mmss(start)} (reload? captions off?); open segments kept`);
  }
  return { ...cue, start, end: start + Math.max(0.5, cue.end - cue.start || 0) };
}

let offset = 0;
let partial = "";
let lastArrival = Date.now();
let stalled = false;

function poll() {
  if (finished || !existsSync(CUE_FILE)) return;
  const size = statSync(CUE_FILE).size;
  if (size < offset) {
    say("cue file shrank; starting over from the top");
    offset = 0;
    partial = "";
  }
  if (size === offset) {
    const quiet = (Date.now() - lastArrival) / 1000;
    if (!opts.once && !stalled && cues > 0 && quiet > STALL_WARN_S) {
      stalled = true;
      say(`WARN    no captions for ${Math.round(quiet)}s: are captions on, and is the tab playing?`);
    }
    return;
  }
  const fd = openSync(CUE_FILE, "r");
  const buf = Buffer.alloc(size - offset);
  readSync(fd, buf, 0, buf.length, offset);
  closeSync(fd);
  offset = size;
  const lines = (partial + buf.toString("utf8")).split("\n");
  partial = opts.once ? "" : lines.pop() ?? "";
  if (opts.once && lines.at(-1) === "") lines.pop();
  if (stalled) say(`        captions resumed after ${Math.round((Date.now() - lastArrival) / 1000)}s`);
  stalled = false;
  lastArrival = Date.now();
  for (const line of lines) {
    const cue = parseCueLine(line, cues);
    if (!cue) continue;
    let wall: number | undefined;
    try {
      wall = JSON.parse(line).wall_time;
    } catch {
      /* parseCueLine already skipped bad lines */
    }
    cues++;
    pipeline.push(onTimeline(cue, wall));
  }
  if (pipeline.stats.preview && !finished) {
    finished = true;
    say(`preview reached at ${mmss(pipeline.stats.preview.from)}: episode over${opts.once ? "" : ". Ctrl+C to stop."}`);
    void wrapUp();
  }
}

async function wrapUp() {
  pipeline.finish();
  // Segments released by finish() start new jobs; wait until none are left
  while (inflight.size) await Promise.all(inflight);
  write(join(RUN, "summary.json"), {
    episode: EPISODE,
    cues,
    prompts: n,
    alerts: alerts.length,
    gaps,
    stats: pipeline.stats,
    usage: jev.usage,
  });
  say(`${cues} cues, ${n} segments, ${alerts.length} events, ${gaps.length} capture gaps -> ${RUN}`);
}

process.on("SIGINT", async () => {
  if (!finished) {
    finished = true;
    say("stopping: flushing open segments...");
    await wrapUp();
  } else while (inflight.size) await Promise.all(inflight);
  process.exit(0);
});

say(
  `${opts.once ? "scan" : "live"}: ${EPISODE}, ${ctx.cast.length} castaways, ` +
  `title ${ctx.title ? `"${ctx.title}"` : "(none: title detection off)"}` +
  (resuming ? `, resuming ${RUN} (saved answers reused)` : "")
);

if (opts.once) {
  poll();
  if (!finished) {
    finished = true;
    await wrapUp();
  } else while (inflight.size) await Promise.all(inflight);
  process.exit(0);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    // Chrome asks before a public page (cbs.com) may call a local address
    "Access-Control-Allow-Private-Network": "true",
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...headers, "Access-Control-Allow-Methods": "GET, OPTIONS" });
    return res.end();
  }
  if (url.pathname === "/alerts") {
    const since = Number(url.searchParams.get("since") ?? 0);
    res.writeHead(200, headers);
    return res.end(JSON.stringify({ run: RUN_ID, episode: EPISODE, alerts: alerts.filter((a) => a.id > since) }));
  }
  if (url.pathname === "/status") {
    res.writeHead(200, headers);
    return res.end(JSON.stringify({ run: RUN_ID, episode: EPISODE, cues, prompts: n, alerts: alerts.length, gaps, finished, usage: jev.usage }));
  }
  res.writeHead(404, headers);
  res.end(JSON.stringify({ error: "not found" }));
});

const PORT = Number(opts.port);
server.listen(PORT, "127.0.0.1", () =>
  say(`watching ${CUE_FILE}${existsSync(CUE_FILE) ? "" : " (not created yet)"}; alerts on http://127.0.0.1:${PORT}/alerts; logging to ${RUN}`)
);
setInterval(poll, 1000);
