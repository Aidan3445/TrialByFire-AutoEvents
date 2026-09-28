import { noul, keyOf, qset, withCanaries } from "./helpers.mjs";
import { phrases } from "../lib/match.mjs";

function build(c) {
  const q = qset();
  q.add("is_winner_reveal", noul("The host reveals the winner of the season in this excerpt."));
  for (const name of withCanaries(c.cast, c))
    q.add(`winner_${keyOf(name)}`, noul(
      `${name} was named the Sole Survivor and won the season. Receiving jury votes without being named the winner does not count.`
    ), "is_winner_reveal");
  return q;
}

export default {
  id: "finale",
  events: ["soleSurvivor"],
  start: phrases(["winner of survivor", "the votes are in", "the votes have been cast"]),
  require: phrases(["winner of survivor", "sole survivor", "you are the winner", "you're the winner"], { exact: true }),
  maxSpan: 600,
  build,
};
