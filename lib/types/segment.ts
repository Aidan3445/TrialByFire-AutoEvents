import type { BaseEventName } from "./events.ts";
import type { Context } from "./context.ts";
import type { Phrase, Match } from "./match.ts";
import type { QSet, Labels, Template } from "./question.ts";
import type { Outcome, Reader } from "./derive.ts";

/**
 * A segment is a part of the episode that may contain an event
 * Each segment has start and end triggers and may have a require trigger that confirms the segment.
 *
 * Info is whatever the question builder needs from the segment text itself
 * (the challenge's one-off team colours); most segments need nothing.
 */
export interface SegmentDef<Info extends object = object> {
  id: string;
  events: BaseEventName[];
  /** Opens a candidate. Near misses allowed. */
  start: Phrase[];
  startNot?: RegExp[];
  /** Confirms a candidate; without it inside maxSpan the candidate is cancelled. */
  require?: Phrase[];
  requireNot?: RegExp[];
  /** Closes a confirmed segment. */
  end?: Phrase[];
  /** Seconds after the start trigger before the candidate is capped. */
  maxSpan: number;
  /** Following cues joined into each match window (default 1). */
  lookahead?: number;
  /** Fold an earlier cancelled candidate into the next confirmed one. */
  mergeIncomplete?: boolean;
  build(ctx: Context, info: Info): QSet;
  /** Reads Info from the assembled segment text. */
  inspect?(text: string): Info;
  /** Info used when hashing the question set version. */
  placeholder?: Info;
  labels?: Labels;
  templates?: Template[];
  /** Anchors that depend on the episode, e.g. the title. */
  withContext?(ctx: Context): Partial<SegmentDef<Info>>;
  /** Turns Jev's answers into draft events, checks, and follow-up questions. */
  derive?(r: Reader, ctx: Context): Outcome;
}

/** An anchor match at a cue. */
export interface Hit extends Match {
  time: number;
  /** Raw text of the matched cue window. */
  text: string;
}

export interface Candidate {
  startIdx: number;
  startTime: number;
  start: Hit;
  require: Hit | null;
  end: Hit | null;
  /** Candidates folded into this one (1 = just itself). */
  mergedFrom: number;
}

export type ClosedBy = "end anchor" | "span cap" | "end of transcript";

export interface Segment extends Candidate {
  def: SegmentDef;
  endIdx: number;
  endTime: number;
  closedBy: ClosedBy;
}

export interface CancelEvent {
  type: "cancel";
  def: SegmentDef;
  start: Hit;
  startTime: number;
  endTime: number;
  reason: string;
}

/** A start trigger opened a candidate. */
export interface OpenEvent {
  type: "open";
  def: SegmentDef;
  start: Hit;
  startTime: number;
}

/** A require hit confirmed a candidate; any opened inside its window were folded in. */
export interface ConfirmEvent {
  type: "confirm";
  def: SegmentDef;
  startTime: number;
  require: Hit;
  absorbed: number;
}

export type ScanEvent = { type: "segment"; segment: Segment } | CancelEvent | OpenEvent | ConfirmEvent;
