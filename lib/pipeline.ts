/**
 * Processes cues segments and jev responses into potential events
 *
 *   const pipeline = createPipeline({ defs, ctx, onSegment, onCancel });
 *   pipeline.push(cue)   // as each cue airs
 *   pipeline.finish()    // stream over (called automatically at the preview)
 *
 * A confirmed segment is held until its tail buffer has aired, then handed to
 * onSegment(segment, prompt).
 */

import { createCleaner } from "./cues.ts";
import { createScanner } from "./scanner.ts";
import { segmentPrompt } from "./prompt.ts";
import type {
  BufferOptions,
  CancelEvent,
  CleanerStats,
  Context,
  Cue,
  Prompt,
  ScanEvent,
  Segment,
  SegmentDef,
} from "./types/index.ts";

export interface PipelineOptions {
  defs: SegmentDef[];
  ctx: Context;
  buffer?: BufferOptions;
  onSegment(segment: Segment, prompt: Prompt): void;
  onCancel?(event: CancelEvent): void;
  /** Every scanner event as it happens: opened, confirmed, closed (before the tail wait), cancelled. */
  onTrace?(event: ScanEvent): void;
}

export interface Pipeline {
  push(cue: Cue): void;
  finish(): void;
  readonly stats: CleanerStats;
}

export function createPipeline({
  defs,
  ctx,
  buffer = { lead: 20, tail: 20 },
  onSegment,
  onCancel = () => { },
  onTrace = () => { },
}: PipelineOptions): Pipeline {
  const cleaner = createCleaner();
  const scanner = createScanner(defs);
  let pending: Segment[] = [];
  let finished = false;

  function handle(events: ScanEvent[]) {
    for (const e of events) {
      onTrace(e);
      if (e.type === "segment") pending.push(e.segment);
      else if (e.type === "cancel") onCancel(e);
    }
  }

  function release(force: boolean) {
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

  function push(cue: Cue) {
    if (finished) return;
    for (const c of cleaner.push(cue)) handle(scanner.push(c));
    release(false);
    if (cleaner.done) finish();
  }

  return { push, finish, stats: cleaner.stats };
}
