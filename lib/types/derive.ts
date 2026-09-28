import type { BaseEventName } from "./events.ts";
import type { Questions } from "./question.ts";

export type Verdict = "yes" | "unsure" | "no";

export interface Scored {
  name: string;
  p: number;
}

/** Per-castaway answers for one question prefix, split by verdict. */
export interface People {
  yes: Scored[];
  unsure: Scored[];
  /** Clears the canary noise floor; used for suggestions and follow-ups. */
  plausible: Scored[];
  /** Highest canary score for this question. */
  floor: number;
}

export interface ChoiceResult {
  value: string;
  confidence: number;
  probabilities: Record<string, number>;
}

/** Read-only view over one segment's answers. */
export interface Reader {
  p(key: string): number | null;
  /** null when the question was not asked. */
  is(key: string): Verdict | null;
  yes(key: string): boolean;
  choice(key: string): ChoiceResult | null;
  /** App label for a choice answer, from the segment's label map. */
  label(key: string, value: string): string | null;
  people(prefix: string, names?: string[]): People;
  keys(pattern: RegExp): string[];
}

export interface Reference {
  type: "Castaway" | "Tribe";
  name: string;
}

/** A field the card should ask about instead of filling in. */
export interface Unresolved {
  field: string;
  reason: string;
  options?: { value: string; confidence?: number }[];
}

export interface DraftEvent {
  eventName: BaseEventName;
  label: string | null;
  references: Reference[];
  notes: string[];
  /** Per field: "event", "label", "ref:<name>", ... */
  confidence: Record<string, number>;
  unresolved: Unresolved[];
}

export interface Check {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

/** What a segment's derive() returns. */
export interface Outcome {
  /** Confidence the scene really happened (the segment's gate question). */
  detected: number | null;
  events: DraftEvent[];
  checks?: Check[];
  /** Questions to ask next, filled from pairing templates. */
  followups?: Questions;
}

export interface Derivation extends Omit<Outcome, "checks" | "followups"> {
  segment: string;
  questionSetVersion: string;
  checks: Check[];
  /** Follow-up questions not answered yet; null when nothing is left to ask. */
  followups: Questions | null;
}
