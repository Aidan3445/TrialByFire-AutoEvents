/**
 * Turns a detected segment into a Jev request: state blob, questions,
 * pairing templates, and meta for provenance.
 */

import { createHash } from "crypto";
import type {
  AnchorHit,
  BufferOptions,
  Context,
  Cue,
  Gap,
  Hit,
  Prompt,
  PromptMeta,
  Segment,
  SegmentDef,
} from "./types/index.ts";

const GAP_S = 20;

const round = (t: number) => Math.round(t * 10) / 10;

function withBuffer(cues: Cue[], seg: Segment, { lead, tail }: BufferOptions): Cue[] {
  const from = seg.startTime - lead;
  const to = seg.endTime + tail;
  const sel = cues.filter((c) => c.start >= from && c.start <= to);
  return sel.length ? sel : cues.slice(seg.startIdx, seg.endIdx + 1);
}

function gapsIn(sel: Cue[]): Gap[] {
  const gaps: Gap[] = [];
  for (let i = 0; i + 1 < sel.length; i++) {
    const d = sel[i + 1].start - sel[i].end;
    if (d > GAP_S) gaps.push({ at: Math.round(sel[i].end), seconds: Math.round(d) });
  }
  return gaps;
}

export function assembleState(sel: Cue[]): string {
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

const PLACEHOLDER_CONTEXT: Context = {
  host: "{Host}",
  cast: ["{Name}"],
  eliminated: ["{Name}"],
  tribes: ["{Tribe}"],
  canaries: [],
  title: "{TITLE}",
};
const versions = new WeakMap<SegmentDef, string>();

// Hash of the wording alone, built against placeholder names, so the version
// changes when a question is reworded and not when the cast changes.
export function questionSetVersion(def: SegmentDef): string {
  let version = versions.get(def);
  if (!version) {
    const { questions } = def.build(PLACEHOLDER_CONTEXT, def.placeholder ?? {});
    const body = JSON.stringify({ questions, templates: def.templates ?? [] });
    version = `${def.id}-${createHash("sha256").update(body).digest("hex").slice(0, 8)}`;
    versions.set(def, version);
  }
  return version;
}

const anchor = (hit: Hit): AnchorHit => ({
  phrase: hit.phrase,
  score: hit.score,
  time: round(hit.time),
  text: hit.text,
});

/** Prompt for one scanned segment, buffered by lead/tail seconds. */
export function segmentPrompt(
  seg: Segment,
  cues: Cue[],
  ctx: Context,
  buffer: BufferOptions = { lead: 20, tail: 20 }
): Prompt {
  const { def } = seg;
  const sel = withBuffer(cues, seg, buffer);
  const transcript = assembleState(sel);
  const { questions, gates } = def.build(ctx, def.inspect?.(transcript) ?? {});
  const templates = def.templates ?? [];
  const meta: PromptMeta = {
    segment: def.id,
    events: def.events,
    questionSetVersion: questionSetVersion(def),
    mergedFrom: seg.mergedFrom,
    anchors: {
      start: anchor(seg.start),
      require: seg.require && anchor(seg.require),
      end: seg.end && anchor(seg.end),
      closedBy: seg.closedBy,
      lastLine: cues[seg.endIdx].text,
    },
    gaps: gapsIn(sel),
    window: { start: round(sel[0].start), end: round(sel[sel.length - 1].end), cues: sel.length, chars: transcript.length },
    firstKey: sel[0].key,
    lastKey: sel[sel.length - 1].key,
    canaries: ctx.canaries,
    labels: def.labels ?? {},
    gates,
  };
  return { state: { host: ctx.host, transcript }, questions, templates, meta };
}
