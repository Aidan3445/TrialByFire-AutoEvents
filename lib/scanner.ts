/**
 * Live segment detection, one cue at a time.
 *
 * A start trigger opens a candidate. Near misses are allowed (see match.ts),
 * so candidates are cheap and get cancelled when the cues that follow show
 * the trigger was not real: a segment with a require that never arrives
 * within maxSpan is cancelled. Segments without a require are confirmed by
 * the trigger itself; end anchors only trim them.
 *
 *   const scanner = createScanner(defs);
 *   scanner.push(cue)  -> events: { type: "segment", segment } | { type: "cancel", ... }
 *   scanner.end()      -> events for whatever is still open
 *
 * Matching looks `lookahead` cues ahead, so cue j is evaluated once cue
 * j + lookahead has arrived.
 */

import { bestMatch, normalize } from "./match.ts";
import type { Candidate, ClosedBy, Cue, Hit, Match, Phrase, ScanEvent, SegmentDef } from "./types/index.ts";

const MERGE_GAP_S = 180;

interface DefState {
  def: SegmentDef;
  open: Candidate[];
  busyUntil: number;
  /** Last cancelled candidate, kept so mergeIncomplete can fold it in. */
  cancelled: (Candidate & { endTime: number }) | null;
}

export interface Scanner {
  push(cue: Cue): ScanEvent[];
  end(): ScanEvent[];
  /** Every cue scanned so far, for building prompt windows. */
  readonly cues: Cue[];
}

// Captions break mid-sentence ("First team" / "to finish wins reward."), so
// anchors match across following cues and exclusions check both neighbours.
const join = (cues: Cue[], from: number, to: number) =>
  cues.slice(Math.max(0, from), to + 1).map((c) => c.text).join(" ");

const lookahead = (def: SegmentDef) => def.lookahead ?? 1;

export function createScanner(defs: SegmentDef[]): Scanner {
  const cues: Cue[] = [];
  const norm: string[] = [];
  const maxAhead = Math.max(1, ...defs.map(lookahead));
  const states: DefState[] = defs.map((def) => ({ def, open: [], busyUntil: -1, cancelled: null }));
  let next = 0;
  let events: ScanEvent[] = [];

  function hitAt(list: Phrase[] | undefined, not: RegExp[] | undefined, def: SegmentDef, j: number): Hit | null {
    if (!list?.length) return null;
    const n = lookahead(def);
    const hit = bestMatch(list, norm.slice(j, j + n + 1).join(""));
    if (!hit || (not && not.some((r) => r.test(join(cues, j - 1, j + 1))))) return null;
    return { ...hit, time: cues[j].start, text: join(cues, j, j + n) };
  }

  const remove = (s: DefState, c: Candidate) => s.open.splice(s.open.indexOf(c), 1);

  // The earliest confirmed candidate covers any opened inside its window
  function absorbLater(s: DefState, c: Candidate) {
    const later = s.open.filter((o) => o.startIdx > c.startIdx);
    for (const o of later) remove(s, o);
    c.mergedFrom += later.length;
    if (c.require)
      events.push({ type: "confirm", def: s.def, startTime: c.startTime, require: c.require, absorbed: later.length });
  }

  function close(s: DefState, c: Candidate, endIdx: number, closedBy: ClosedBy) {
    const { def } = s;
    // Arrival and rules can sit on the far side of an ad break from the result
    if (def.mergeIncomplete && s.cancelled && c.startTime - s.cancelled.endTime <= MERGE_GAP_S) {
      c.startIdx = s.cancelled.startIdx;
      c.startTime = s.cancelled.startTime;
      c.start = s.cancelled.start;
      c.mergedFrom += s.cancelled.mergedFrom;
    }
    s.cancelled = null;
    s.busyUntil = endIdx;
    events.push({
      type: "segment",
      segment: { def, ...c, endIdx, endTime: cues[endIdx].end, closedBy },
    });
  }

  function cancel(s: DefState, c: Candidate, endIdx: number, reason: string) {
    const endTime = cues[endIdx].end;
    const chained =
      s.def.mergeIncomplete && s.cancelled && c.startTime - s.cancelled.endTime <= MERGE_GAP_S;
    s.cancelled =
      chained && s.cancelled
        ? { ...s.cancelled, endTime, mergedFrom: s.cancelled.mergedFrom + c.mergedFrom }
        : { ...c, endTime };
    events.push({ type: "cancel", def: s.def, start: c.start, startTime: c.startTime, endTime, reason });
  }

  function evaluate(j: number) {
    for (const s of states) {
      const { def } = s;
      for (const c of [...s.open]) {
        if (!s.open.includes(c)) continue;
        if (cues[j].start - c.startTime > def.maxSpan) {
          remove(s, c);
          if (c.require || !def.require) close(s, c, j - 1, "span cap");
          else cancel(s, c, j - 1, `no require within ${def.maxSpan}s`);
          continue;
        }
        if (def.require && !c.require) {
          c.require = hitAt(def.require, def.requireNot, def, j);
          if (c.require) absorbLater(s, c);
          continue;
        }
        if (j > c.startIdx && def.end) {
          const hit = hitAt(def.end, undefined, def, j);
          if (hit) {
            remove(s, c);
            close(s, { ...c, end: hit }, j, "end anchor");
          }
        }
      }

      // Unconfirmed candidates may be false starts, so a require-gated segment
      // can have several open; anything else is one scene at a time
      const canOpen = !s.open.length || (def.require && s.open.every((c) => !c.require));
      // The same trigger also matches from the cue before it via lookahead
      const sameTrigger = s.open.some((c) => j - c.startIdx <= lookahead(def));
      if (j <= s.busyUntil || !canOpen || sameTrigger) continue;
      const start = hitAt(def.start, def.startNot, def, j);
      if (!start) continue;
      const c: Candidate = { startIdx: j, startTime: cues[j].start, start, require: null, end: null, mergedFrom: 1 };
      s.open.push(c);
      events.push({ type: "open", def, start, startTime: c.startTime });
      if (def.require) {
        c.require = hitAt(def.require, def.requireNot, def, j);
        if (c.require) absorbLater(s, c);
      }
    }
  }

  function drain(): ScanEvent[] {
    const out = events;
    events = [];
    return out;
  }

  function push(cue: Cue): ScanEvent[] {
    cues.push(cue);
    norm.push(normalize(cue.text));
    while (next + maxAhead < cues.length) evaluate(next++);
    return drain();
  }

  function end(): ScanEvent[] {
    while (next < cues.length) evaluate(next++);
    const last = cues.length - 1;
    for (const s of states)
      for (const c of [...s.open]) {
        remove(s, c);
        if (c.require || !s.def.require) close(s, c, last, "end of transcript");
        else cancel(s, c, last, "stream ended before require");
      }
    return drain();
  }

  return { push, end, cues };
}

export interface AuditHit extends Match {
  kind: "start" | "require" | "end";
  excluded: boolean;
  cue: Cue;
}

/** Every anchor hit per definition over a complete cue list, for tuning. */
export function auditAnchors(cues: Cue[], defs: SegmentDef[]): { id: string; hits: AuditHit[] }[] {
  const norm = cues.map((c) => normalize(c.text));
  const kinds = [
    ["start", "startNot"],
    ["require", "requireNot"],
    ["end", null],
  ] as const;
  return defs.map((def) => {
    const n = lookahead(def);
    const hits: AuditHit[] = [];
    for (const [kind, not] of kinds) {
      const list = def[kind];
      if (!list?.length) continue;
      const exclusions = not ? def[not] : undefined;
      for (let j = 0; j < cues.length; j++) {
        const hit = bestMatch(list, norm.slice(j, j + n + 1).join(""));
        if (!hit) continue;
        const excluded = Boolean(exclusions?.some((r) => r.test(join(cues, j - 1, j + 1))));
        hits.push({ kind, excluded, ...hit, cue: cues[j] });
      }
    }
    return { id: def.id, hits };
  });
}
