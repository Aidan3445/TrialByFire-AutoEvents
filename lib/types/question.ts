/** Independent yes/no with a probability. */
export interface Noul {
  type: "noul";
  instructions: string;
}

/** Argmax over a fixed option set; the model cannot invent an option. */
export interface Choice<K extends string = string> {
  type: "choice";
  instructions: string;
  criteria: Record<K, string>;
}

export type Question = Noul | Choice;

/** Question key -> question, as pasted into the playground. */
export type Questions = Record<string, Question>;

/**
 * Question key -> the answer it depends on, e.g. "attended_heidi" or
 * "team_count=three_or_more". Only asked once the gate is confirmed.
 */
export type Gates = Record<string, string>;

export interface QSet {
  questions: Questions;
  gates: Gates;
  add(key: string, spec: Question, gate?: string): void;
}

/** Follow-up questions with {placeholders}, filled in from confirmed answers. */
export type Template = Record<string, Question>;

/** Choice question key (or "prefix_*") -> option key -> app label. */
export type Labels = Record<string, Record<string, string>>;
