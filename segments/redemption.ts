import { noul, choice, keyOf, qset, withCanaries } from "./helpers.ts";
import { phrases } from "../lib/match.ts";
import type { Context, SegmentDef } from "../lib/types/index.ts";

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
  labels: { redemption_kind: REDEMPTION_KINDS },
};

export default redemption;
