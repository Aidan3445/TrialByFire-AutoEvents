import { noul, choice, keyOf, qset, withCanaries } from "./helpers.ts";
import { phrases } from "../lib/match.ts";
import { choiceLabel, draft, gate, pick } from "../lib/derive.ts";
import type { Context, Outcome, Reader, SegmentDef } from "../lib/types/index.ts";

function derive(r: Reader, c: Context): Outcome {
  const g = gate(r, "returned_to_game");
  if (!g.open) return { detected: g.detected, events: [] };
  // Only eliminated castaways are asked, so a prior elimination holds by construction
  const who = r.people("returned_", c.eliminated);
  const kind = choiceLabel(r, "redemption_kind");
  return {
    detected: g.detected,
    events: [
      draft("redemption", {
        label: kind.label,
        labelConfidence: kind.confidence,
        confidence: g.detected,
        people: who.yes,
        unresolved: [...g.doubt, ...kind.unresolved, ...(who.yes.length ? [] : [pick("references", who, "who returned")])],
      }),
    ],
  };
}

const REDEMPTION_KINDS = {
  redemption_island: "Redemption",
  edge_of_extinction: "Edge of Extinction",
  outcasts: "Outcasts",
  second_chance: "Second Chance",
};

function build(c: Context) {
  const q = qset();
  q.add("returned_to_game", noul(
    "A castaway who had been eliminated re-entered the game in this excerpt. Being given a chance to return but failing does not count."
  ));
  q.add("redemption_kind", choice<keyof typeof REDEMPTION_KINDS>("How did the eliminated castaway get back into the game?", {
    redemption_island: "by winning a duel at Redemption Island",
    edge_of_extinction: "by winning a return challenge from the Edge of Extinction",
    outcasts: "by competing as a tribe of voted-out castaways against the remaining tribes",
    second_chance: "by some other twist that brings an eliminated castaway back",
  }), "returned_to_game");
  for (const name of withCanaries(c.eliminated, c))
    q.add(`returned_${keyOf(name)}`, noul(
      `${name} is the eliminated castaway who re-entered the game.`
    ), "returned_to_game");
  return q;
}

const redemption: SegmentDef = {
  id: "redemption",
  events: ["redemption"],
  start: phrases([
    "edge of extinction",
    "redemption island",
    "the outcasts",
    "back in the game",
    "back into the game",
    "return to the game",
    "returning to the game",
    "re-enter the game",
    "second chance",
    "earn your way back",
    "earn their way back",
    "rejoin the game",
  ]),
  maxSpan: 300,
  build,
  derive,
  labels: { redemption_kind: REDEMPTION_KINDS },
};

export default redemption;
