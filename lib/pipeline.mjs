/**
 * Live extraction: raw caption cues in, Jev prompts out.
 *
 *   const pipeline = createPipeline({ defs, ctx, onSegment, onCancel });
 *   pipeline.push(cue)   // as each cue airs
 *   pipeline.finish()    // stream over (called automatically at the preview)
 *
 * A confirmed segment is held until its tail buffer has aired, then handed to
 * onSegment(segment, prompt).
 */

import { createCleaner } from "./cues.mjs";
import { createScanner } from "./scanner.mjs";
import { segmentPrompt } from "./prompt.mjs";

export function createPipeline({ defs, ctx, buffer = { lead: 20, tail: 20 }, onSegment, onCancel = () => {} }) {
  const cleaner = createCleaner();
  const scanner = createScanner(defs);
  let pending = [];
  let finished = false;

  function handle(events) {
    for (const e of events) {
      if (e.type === "segment") pending.push(e.segment);
      else onCancel(e);
    }
  }

  function release(force) {
    const aired = scanner.cues.at(-1)?.start ?? -Infinity;
    const ready = pending.filter((s) => force || aired >= s.endTime + buffer.tail);
    pending = pending.filter((s) => !ready.includes(s));
    for (const seg of ready) onSegment(seg, segmentPrompt(seg, scanner.cues, ctx, buffer));
  }

  function finish() {
    if (finished) return;
    finished = true;
    for (const c of cleaner.end()) handle(scanner.push(c));
    handle(scanner.end());
    release(true);
  }

  function push(cue) {
    if (finished) return;
    for (const c of cleaner.push(cue)) handle(scanner.push(c));
    release(false);
    if (cleaner.done) finish();
  }

  return { push, finish, stats: cleaner.stats };
}
