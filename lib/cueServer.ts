/**
 * Local cue receiver.
 *
 * Takes caption cues from the browser tap, dedupes them, persists to JSONL, and
 * serves a time range back as one state blob for the extractor
 *
 *   node lib/cueServer.ts --out cues/s47e08.jsonl
 *
 *   POST /cue        {"cues": [ ... ]}        from the extension
 *   GET  /segment?start=1200&end=1500         -> assembled state text
 *   GET  /status                              -> counts, gaps, timeline health
 */

import { createServer, type ServerResponse } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { StoredCue, SuspectScore } from "./types/index.ts";

const args = process.argv.slice(2);
const argOf = (flag: string, fallback: string) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const OUT = argOf("--out", "cues.jsonl");
const PORT = Number(argOf("--port", "8000"));

/** key -> cue */
const CUES = new Map<string, StoredCue>();

// The CBS player sometimes displays junk caption rows full of random special characters
// they also usually last longer than a normal caption, and repeat themselves
const CLEAN = new Set(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,'\"?!-:;"
);
const MAX_SANE_DURATION = 10;

export function suspectScore(cue: { text?: string; start?: number | null; end?: number | null }): SuspectScore {
  const text = cue.text ?? "";
  const reasons: string[] = [];
  let score = 0;

  // Too many special chars
  if (text.length) {
    let dirty = 0;
    for (const ch of text) if (!CLEAN.has(ch)) dirty++;
    const ratio = dirty / text.length;
    if (ratio > 0.12) {
      score += Math.min(ratio * 2, 0.6);
      reasons.push(`non-caption characters (${Math.round(ratio * 100)}%)`);
    }
  }

  // Too long
  if (cue.start != null && cue.end != null) {
    const dur = cue.end - cue.start;
    if (dur > MAX_SANE_DURATION) {
      score += 0.4;
      reasons.push(`duration ${dur.toFixed(1)}s`);
    }
  }

  // Repeated phrase
  const toks = text.split(/\s+/).filter(Boolean);
  let best = 0;
  for (let n = 2; n <= Math.max(2, Math.floor(toks.length / 3)); n++) {
    const counts = new Map<string, number>();
    for (let i = 0; i + n <= toks.length; i++) {
      const gram = toks.slice(i, i + n).join(" ");
      counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }
    for (const c of counts.values()) if (c >= 3 && c > best) best = c;
  }
  if (best >= 3) {
    score += 0.4;
    reasons.push(`phrase repeated ${best}x`);
  }

  return { score: Math.min(score, 1), reasons };
}

/** true if new */
function record(cue: StoredCue): boolean {
  const key = cue.key;
  if (!key || CUES.has(key)) return false;
  cue.received_at = new Date().toISOString();
  const { score, reasons } = suspectScore(cue);
  cue.suspect = score >= 0.5;
  cue.suspect_score = Math.round(score * 100) / 100;
  cue.suspect_reasons = reasons;
  CUES.set(key, cue);
  appendFileSync(OUT, JSON.stringify(cue) + "\n", "utf8");
  return true;
}

function loadExisting() {
  if (!existsSync(OUT)) return;
  for (const line of readFileSync(OUT, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const c: StoredCue = JSON.parse(line);
      if (c.key) CUES.set(c.key, c);
    } catch {
      /* ignore */
    }
  }
}

const norm = (t: string | undefined) => (t ?? "").replace(/\s+/g, " ").trim().toUpperCase();

// Remove "scroll" duplicates
const DUP_WINDOW_S = 10;

function markDuplicates(cues: StoredCue[]): StoredCue[] {
  let lastText: string | null = null;
  let lastStart: number | null = null;
  for (const c of cues) {
    const t = norm(c.text);
    const near =
      lastStart != null && c.start != null && Math.abs(c.start - lastStart) <= DUP_WINDOW_S;
    c.duplicate = Boolean(t && t === lastText && near);
    if (!c.duplicate) {
      lastText = t;
      lastStart = c.start ?? null;
    }
  }
  return cues;
}

const ordered = () =>
  markDuplicates(
    [...CUES.values()].sort(
      (a, b) => (a.start ?? 0) - (b.start ?? 0) || a.key.localeCompare(b.key)
    )
  );

function segment(start: number, end: number, includeSuspect = false) {
  const inRange = ordered().filter(
    (c) => c.start != null && c.start >= start && c.start <= end
  );
  const usable = inRange.filter((c) => !c.duplicate);
  const sel = includeSuspect ? usable : usable.filter((c) => !c.suspect);
  const dropped = inRange.filter((c) => c.suspect).map((c) => c.key);
  const scrollRepeats = inRange.filter((c) => c.duplicate).length;

  const parts = sel.map((c, i) => {
    let sep;
    if (i === 0) sep = "";
    else if (c.boundary === "topic") sep = "\n\n";
    else if (c.boundary === "speaker") sep = "\n";
    else sep = " ";
    return sep + c.text;
  });

  return {
    start,
    end,
    cue_count: sel.length,
    dropped_suspect: dropped,
    dropped_scroll_repeats: scrollRepeats,
    first_key: sel[0]?.key ?? null,
    last_key: sel.at(-1)?.key ?? null,
    state: parts.join("").trim(),
  };
}

function status() {
  const all = ordered();
  const cues = all.filter((c) => !c.suspect && !c.duplicate);
  const suspects = all.filter((c) => c.suspect);
  const duplicates = all.filter((c) => c.duplicate);

  const gaps: { after_key: string; at: number; seconds: number }[] = [];
  for (let i = 0; i + 1 < cues.length; i++) {
    const a = cues[i];
    const b = cues[i + 1];
    if (a.end == null || b.start == null) continue;
    const delta = b.start - a.end;
    // Long pauses are recorded as gaps
    if (delta > 20)
      gaps.push({ after_key: a.key, at: a.end, seconds: Math.round(delta * 10) / 10 });
  }

  // Sometimes ads come in on a separate timeline
  const drift: { key: string; delta: number }[] = [];
  for (const c of cues.slice(-50)) {
    if (c.media_time == null || c.start == null) continue;
    const d = Math.abs(c.media_time - c.start);
    if (d > 5) drift.push({ key: c.key, delta: Math.round(d * 10) / 10 });
  }

  return {
    cues: cues.length,
    raw_cues: all.length,
    scroll_repeats: duplicates.length,
    suspect_total: suspects.length,
    suspect_cues: suspects.slice(-5).map((c) => ({
      key: c.key,
      score: c.suspect_score,
      reasons: c.suspect_reasons,
    })),
    span: cues.length ? [cues[0].start, cues[cues.length - 1].end] : null,
    gaps: gaps.slice(-10),
    timeline_drift: drift.slice(-5),
    out: OUT,
  };
}

function send(res: ServerResponse, code: number, body: unknown) {
  const raw = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Length": Buffer.byteLength(raw),
  });
  res.end(raw);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (process.env.QUIET !== "1")
    console.log(`${req.method} ${url.pathname}${url.search}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    });
    return res.end();
  }

  if (req.method === "POST" && url.pathname === "/cue") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let payload: { cues?: StoredCue[] };
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        return send(res, 400, { error: "bad json" });
      }
      let added = 0;
      for (const cue of payload.cues ?? []) if (record(cue)) added++;
      const n = (payload.cues ?? []).length;
      const last = (payload.cues ?? []).at(-1);
      console.log(
        `[cue] +${added}/${n}  total=${CUES.size}` +
        (last?.start != null ? `  t=${last.start.toFixed(1)}s` : "") +
        (last?.text ? `  ${last.text.slice(0, 48)}` : "")
      );
      send(res, 200, { accepted: added, total: CUES.size });
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    return send(res, 200, {
      ok: true,
      cues: CUES.size,
      out: OUT,
      routes: {
        "POST /cue": "receive cues from the extension",
        "GET /status": "counts, gaps, timeline drift, suspect cues",
        "GET /segment?start=&end=": "assembled state text for a time range",
      },
    });
  }

  if (req.method === "GET" && url.pathname === "/status") {
    return send(res, 200, status());
  }

  if (req.method === "GET" && url.pathname === "/segment") {
    const start = Number(url.searchParams.get("start") ?? 0);
    const end = Number(url.searchParams.get("end") ?? 1e9);
    if (!Number.isFinite(start) || !Number.isFinite(end))
      return send(res, 400, { error: "start/end must be numbers" });
    const incl = !["0", "false", "", null].includes(
      url.searchParams.get("include_suspect")
    );
    return send(res, 200, segment(start, end, incl));
  }

  send(res, 404, { error: "not found" });
});

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = dirname(OUT);
  if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  loadExisting();
  server.listen(PORT, "127.0.0.1", () => {
    console.log(
      `cue server on http://127.0.0.1:${PORT}  -> ${OUT} (${CUES.size} cues loaded)`
    );
  });
}
