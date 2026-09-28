/**
 * Cue cleaning, one cue at a time as they arrive. Expects cues in airing order.
 *
 *   const cleaner = createCleaner();
 *   cleaner.push(cue)   -> cues released for scanning (often [] or [cue])
 *   cleaner.end()       -> anything still held back
 *   cleaner.done        -> true once the "next time on" preview starts
 */

import { suspectScore } from "./cueServer.ts";
import type { Cue, CleanerStats } from "./types/index.ts";

const REPEAT_WINDOW_S = 10;
const RECAP_SEARCH_S = 600;
const RECAP_MAX_S = 300;
const RECAP_FALLBACK_S = 180;
// "next time on" earlier than this is not the closing preview
const PREVIEW_MIN_S = 1800;

export interface Cleaner {
  push(cue: Cue): Cue[];
  end(): Cue[];
  readonly stats: CleanerStats;
  readonly done: boolean;
}

export function createCleaner(): Cleaner {
  const stats: CleanerStats = { loaded: 0, deduped: 0, recap: null, preview: null };
  let lastText: string | null = null;
  let lastStart: number | null = null;
  let t0: number | null = null;
  let recap: "searching" | "holding" | "done" = "searching";
  let held: Cue[] = [];
  let from = 0;
  let done = false;

  // No closing "the tribe has spoken" in time: drop only the opening stretch
  function releaseFallback(): Cue[] {
    const drop = held.filter((c) => c.start - from <= RECAP_FALLBACK_S);
    stats.recap = {
      from,
      to: drop.at(-1)?.end ?? from,
      cues: drop.length,
      closedBy: `fallback ${RECAP_FALLBACK_S}s`,
    };
    const keep = held.slice(drop.length);
    held = [];
    recap = "done";
    return keep;
  }

  // "Previously on Survivor" replays last week's vote, which would otherwise
  // produce a tribal and an elimination for the wrong episode
  function stripRecap(c: Cue, t0: number): Cue[] {
    if (recap === "searching") {
      if (c.start - t0 > RECAP_SEARCH_S) recap = "done";
      else if (/previously on survivor/i.test(c.text)) {
        recap = "holding";
        from = c.start;
      }
    }
    if (recap !== "holding") return [c];
    held.push(c);
    if (c.start - from <= RECAP_MAX_S && /the tribe has spoken/i.test(c.text)) {
      stats.recap = { from, to: c.end, cues: held.length, closedBy: "the tribe has spoken" };
      held = [];
      recap = "done";
      return [];
    }
    return c.start - from > RECAP_MAX_S ? releaseFallback() : [];
  }

  function push(cue: Cue): Cue[] {
    if (done) return [];
    // Synthetic timing would trip the duration signal, so score on text only
    if (suspectScore(cue.synthetic ? { text: cue.text } : cue).score >= 0.5) return [];
    stats.loaded++;

    // Scroll repeats: same text, near-identical timing, new key
    const t = cue.text.toUpperCase();
    if (t && t === lastText && lastStart != null && Math.abs(cue.start - lastStart) <= REPEAT_WINDOW_S)
      return [];
    lastText = t;
    lastStart = cue.start;
    stats.deduped++;

    t0 ??= cue.start;
    // "Next time on Survivor" previews next week's swaps, idols and exits
    if (cue.start - t0 >= PREVIEW_MIN_S && /next time on/i.test(cue.text)) {
      done = true;
      stats.preview = { from: cue.start };
      return recap === "holding" ? releaseFallback() : [];
    }
    return stripRecap(cue, t0);
  }

  function end(): Cue[] {
    return recap === "holding" ? releaseFallback() : [];
  }

  return {
    push,
    end,
    stats,
    get done() {
      return done;
    },
  };
}

/** Clean a complete episode in one go. */
export function cleanAll(raw: Cue[]): { cues: Cue[]; stats: CleanerStats } {
  const cleaner = createCleaner();
  const cues = [...raw.flatMap((c) => cleaner.push(c)), ...cleaner.end()];
  return { cues, stats: cleaner.stats };
}
