import type { BaseEventName } from "./events.ts";
import type { ClosedBy } from "./segment.ts";
import type { Gates, Labels, Questions, Template } from "./question.ts";

/** Seconds of context kept either side of a segment. */
export interface BufferOptions {
  lead: number;
  tail: number;
}

export interface Gap {
  at: number;
  seconds: number;
}

export interface AnchorHit {
  phrase: string;
  score: number;
  time: number;
  text: string;
}

export interface Anchors {
  start: AnchorHit;
  require: AnchorHit | null;
  end: AnchorHit | null;
  closedBy: ClosedBy;
  lastLine: string;
}

/** Provenance stored with every suggestion. */
export interface PromptMeta {
  segment: string;
  events: BaseEventName[];
  questionSetVersion: string;
  mergedFrom: number;
  anchors: Anchors;
  gaps: Gap[];
  window: { start: number; end: number; cues: number; chars: number };
  firstKey: string;
  lastKey: string;
  canaries: string[];
  labels: Labels;
  gates: Gates;
}

/** One Jev request: state blob, questions, pairing templates, and meta. */
export interface Prompt {
  state: { host: string; transcript: string };
  questions: Questions;
  templates: Template[];
  meta: PromptMeta;
}
