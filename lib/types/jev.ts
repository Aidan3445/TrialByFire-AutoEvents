import type { Questions } from "./question.ts";

export interface NoulAnswer {
  type: "noul";
  noul: number;
  stats?: Record<string, unknown>;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
  stats?: Record<string, unknown>;
}

export type Answer = NoulAnswer | ChoiceAnswer;

/** Question key -> answer. */
export type Answers = Record<string, Answer>;

export interface JevResponse {
  model: string;
  answers: Answers;
  usage?: { input_tokens: number; output_tokens: number };
  request_id?: string;
  evaluation_time_ms?: number;
}

/** A follow-up run: the filled-in template questions and Jev's response to them. */
export interface FollowupRun {
  qSet: Questions;
  response: JevResponse;
}
