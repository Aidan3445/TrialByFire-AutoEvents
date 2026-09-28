import { rx, noul, choice, keyOf, qset, withCanaries } from "./helpers.ts";
import { phrases } from "../lib/match.ts";
import type { Context, SegmentDef } from "../lib/types/index.ts";

const EXIT_KINDS = { med_evac: "Med Evacuation", quit: "Quit", removed: "Removed" };

function build(c: Context) {
  const q = qset();
  q.add("exit_occurred", noul(
    "A castaway left the game in this excerpt for a reason other than being voted out — a medical evacuation, quitting, or being removed. Being examined by medical and continuing to play does not count. Talking about quitting without leaving does not count."
  ));
  q.add("exit_kind", choice<keyof typeof EXIT_KINDS>("Why did the castaway leave the game?", {
    med_evac: "they were removed for medical reasons",
    quit: "they chose to quit",
    removed: "production removed them for their conduct",
  }), "exit_occurred");
  for (const name of withCanaries(c.cast, c))
    q.add(`left_game_${keyOf(name)}`, noul(
      `${name} is the castaway who left the game in this excerpt without being voted out.`
    ), "exit_occurred");
  return q;
}

const exit: SegmentDef = {
  id: "exit",
  events: ["noVoteExit"],
  start: phrases([
    "medical",
    "have to pull you",
    "going to pull you",
    "need to pull you",
    "pull you from the game",
    "pulled from the game",
    "pulled out of the game",
    "your game is over",
    "evacuat",
    "can't continue",
    "want to quit",
    "going to quit",
    "decided to quit",
    "i quit",
    "quit the game",
    "removed from the game",
    "leave the game",
    "leaving the game",
  ]),
  startNot: rx(["voted out", "(leave|leaving) (the game|tribal council) immediately"]),
  maxSpan: 300,
  build,
  labels: { exit_kind: EXIT_KINDS },
};

export default exit;
