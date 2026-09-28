import { noul, keyOf, qset, withCanaries } from "./helpers.ts";
import { phrases } from "../lib/match.ts";
import { check, draft, gate, names, pick } from "../lib/derive.ts";
import type { Context, Outcome, Reader, SegmentDef } from "../lib/types/index.ts";

function derive(r: Reader): Outcome {
  const g = gate(r, "is_winner_reveal");
  if (!g.open) return { detected: g.detected, events: [] };
  const winner = r.people("winner_");
  return {
    detected: g.detected,
    events: [
      draft("soleSurvivor", {
        label: "Sole Survivor",
        confidence: g.detected,
        people: winner.yes,
        unresolved: [...g.doubt, ...(winner.yes.length === 1 ? [] : [pick("references", winner, "who won")])],
      }),
    ],
    checks: [check("exactly one Sole Survivor", winner.yes.length === 1, names(winner.yes) || "none")],
  };
}

function build(c: Context) {
  const q = qset();
  q.add("is_winner_reveal", noul("The host reveals the winner of the season in this excerpt."));
  for (const name of withCanaries(c.cast, c))
    q.add(`winner_${keyOf(name)}`, noul(
      `${name} was named the Sole Survivor and won the season. Receiving jury votes without being named the winner does not count.`
    ), "is_winner_reveal");
  return q;
}

const finale: SegmentDef = {
  id: "finale",
  events: ["soleSurvivor"],
  start: phrases(["winner of survivor", "the votes are in", "the votes have been cast"]),
  require: phrases(["winner of survivor", "sole survivor", "you are the winner", "you're the winner"], { exact: true }),
  maxSpan: 600,
  build,
  derive,
};

export default finale;
