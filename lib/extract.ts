/**
 * One segment end to end: prompt -> Jev -> derive, then any follow-up
 * questions derive() asks for (e.g. advantage pairing) -> Jev -> derive again.
 */

import { deriveSegment } from "./derive.ts";
import type { JevClient } from "./jev.ts";
import type { Answers, Context, Derivation, FollowupRun, JevResponse, Prompt, SegmentDef } from "./types/index.ts";

export interface Extraction {
  main: JevResponse;
  followup: FollowupRun | null;
  derivation: Derivation;
}

export async function extract(def: SegmentDef, prompt: Prompt, ctx: Context, jev: JevClient): Promise<Extraction> {
  const main = await jev.ask(prompt.state, prompt.questions);
  const answers: Answers = { ...main.answers };
  let derivation = deriveSegment(def, ctx, answers);
  let followup: FollowupRun | null = null;
  if (derivation.followups) {
    const response = await jev.ask(prompt.state, derivation.followups);
    followup = { qSet: derivation.followups, response };
    Object.assign(answers, response.answers);
    derivation = deriveSegment(def, ctx, answers);
  }
  return { main, followup, derivation };
}
