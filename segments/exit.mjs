import { rx, noul, choice, keyOf, qset, withCanaries } from "./helpers.mjs";
import { phrases } from "../lib/match.mjs";

function build(c) {
  const q = qset();
  q.add("exit_occurred", noul(
    "A castaway left the game in this excerpt for a reason other than being voted out — a medical evacuation, quitting, or being removed. Being examined by medical and continuing to play does not count. Talking about quitting without leaving does not count."
  ));
  q.add("exit_kind", choice("Why did the castaway leave the game?", {
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

export default {
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
  labels: { exit_kind: { med_evac: "Med Evacuation", quit: "Quit", removed: "Removed" } },
};
