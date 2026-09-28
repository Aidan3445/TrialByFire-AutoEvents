/**
 * Turns a detected segment into a Jev request: state blob, questions,
 * pairing templates, and meta for provenance.
 */

import { createHash } from "crypto";

const GAP_S = 20;

const round = (t) => (t == null ? t : Math.round(t * 10) / 10);

function withBuffer(cues, seg, lead, tail) {
  const from = seg.startTime - lead;
  const to = seg.endTime + tail;
  const sel = cues.filter((c) => c.start >= from && c.start <= to);
  return sel.length ? sel : cues.slice(seg.startIdx, seg.endIdx + 1);
}

function gapsIn(sel) {
  const gaps = [];
  for (let i = 0; i + 1 < sel.length; i++) {
    const d = sel[i + 1].start - sel[i].end;
    if (d > GAP_S) gaps.push({ at: Math.round(sel[i].end), seconds: Math.round(d) });
  }
  return gaps;
}

export function assembleState(sel) {
  return sel
    .map((c, i) => {
      if (i === 0) return c.text;
      if (c.boundary === "topic") return "\n\n" + c.text;
      if (c.boundary === "speaker") return "\n" + c.text;
      return " " + c.text;
    })
    .join("")
    .trim();
}

const PLACEHOLDER_CONTEXT = {
  cast: ["{Name}"],
  eliminated: ["{Name}"],
  tribes: ["{Tribe}"],
  canaries: [],
  title: "{TITLE}",
};
const versions = new WeakMap();

// Hash of the wording alone, built against placeholder names, so the version
// changes when a question is reworded and not when the cast changes.
export function questionSetVersion(def) {
  if (!versions.has(def)) {
    const { questions } = def.build(PLACEHOLDER_CONTEXT, def.placeholder ?? {});
    const body = JSON.stringify({ questions, templates: def.templates ?? [] });
    versions.set(def, `${def.id}-${createHash("sha256").update(body).digest("hex").slice(0, 8)}`);
  }
  return versions.get(def);
}

function buildPrompt(def, ctx, sel, extraMeta) {
  const transcript = assembleState(sel);
  const { questions, gates } = def.build(ctx, def.inspect?.(transcript) ?? {});
  const templates = def.templates ?? [];
  return {
    state: { host: ctx.host, transcript },
    questions,
    templates,
    meta: {
      segment: def.id,
      events: def.events,
      questionSetVersion: questionSetVersion(def),
      ...extraMeta,
      window: { start: round(sel[0]?.start), end: round(sel.at(-1)?.end), cues: sel.length, chars: transcript.length },
      firstKey: sel[0]?.key,
      lastKey: sel.at(-1)?.key,
      canaries: ctx.canaries,
      labels: def.labels ?? {},
      gates,
    },
  };
}

const anchor = (hit) => hit && { phrase: hit.phrase, score: hit.score, time: round(hit.time), text: hit.text };

/** Prompt for one scanned segment, buffered by lead/tail seconds. */
export function segmentPrompt(seg, cues, ctx, { lead = 20, tail = 20 } = {}) {
  const sel = withBuffer(cues, seg, lead, tail);
  return buildPrompt(seg.def, ctx, sel, {
    mergedFrom: seg.mergedFrom,
    anchors: {
      start: anchor(seg.start),
      require: anchor(seg.require),
      end: anchor(seg.end),
      closedBy: seg.closedBy,
      lastLine: cues[seg.endIdx].text,
    },
    gaps: gapsIn(sel),
  });
}
