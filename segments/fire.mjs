import { rx, noul, keyOf, qset, withCanaries, RULES_TALK } from "./helpers.mjs";
import { phrases } from "../lib/match.mjs";

function build(c) {
  const q = qset();
  q.add("fire_challenge_occurred", noul(
    "A fire-making challenge was held in this excerpt. Practising fire at camp, or talking about fire-making, does not count."
  ));
  for (const name of withCanaries(c.cast, c)) {
    const k = keyOf(name);
    q.add(`fire_competed_${k}`, noul(`${name} competed in the fire-making challenge.`), "fire_challenge_occurred");
    q.add(`fire_win_${k}`, noul(
      `${name} won the fire-making challenge. Competing in it or nearly winning does not count.`
    ), "fire_challenge_occurred");
  }
  return q;
}

export default {
  id: "fire",
  events: ["fireWin", "noVoteExit"],
  start: phrases([
    "fire-making challenge",
    "burn through that rope",
    "burn through the rope",
  ]),
  require: phrases([
    "'s done it",
    "has done it",
    "earned the final spot",
    "earned the third spot",
    "wins fire",
    "win fire",
    "won fire",
    "burned through",
    "burnt through",
  ], { exact: true }),
  requireNot: rx(RULES_TALK),
  end: phrases(["the tribe has spoken", "bring me your torch", "snuff"]),
  maxSpan: 900,
  build,
};
