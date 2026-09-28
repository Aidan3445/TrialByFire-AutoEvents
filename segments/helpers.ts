import type { Choice, Context, Noul, QSet, Question } from "../lib/types/index.ts";

export const rx = (arr: string[]): RegExp[] => arr.map((s) => new RegExp(s, "i"));

export const noul = (instructions: string): Noul => ({ type: "noul", instructions });
export const choice = <K extends string>(instructions: string, criteria: Record<K, string>): Choice<K> => ({
  type: "choice",
  instructions,
  criteria,
});
export const keyOf = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
export const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

// Mix in the canaries for testing the system against non-existing castaways
export const withCanaries = (names: string[], ctx: Context): string[] =>
  [...new Set([...names, ...ctx.canaries])].sort();

export function qset(): QSet {
  const questions: Record<string, Question> = {};
  const gates: Record<string, string> = {};
  return {
    questions,
    gates,
    add(key, spec, gate) {
      questions[key] = spec;
      if (gate) gates[key] = gate;
    },
  };
}

// The host describing what is about to happen, not the result
export const RULES_TALK = [
  "\\b(first|last) (tribe|team|person|one|two|three|castaway|to)\\b",
  "\\bwhoever\\b",
  "\\b(will|to|going to|trying to|want to|hope to|could|can|might|would|gonna) win\\b",
  "\\bto finish\\b",
  "\\bwinners? (will|get|gets|receive|take|takes)\\b",
  "\\bthe winner (will|gets|of this)\\b",
  "\\bwins? (immunity|reward)\\?",
];
