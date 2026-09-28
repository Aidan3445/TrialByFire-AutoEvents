import { noul, keyOf, qset, withCanaries } from "./helpers.ts";
import { phrases } from "../lib/match.ts";
import type { Context, SegmentDef } from "../lib/types/index.ts";

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
};

export default finale;
