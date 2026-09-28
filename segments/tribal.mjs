import { noul, choice, keyOf, qset, withCanaries } from "./helpers.mjs";
import { phrases } from "../lib/match.mjs";
import { advantageCriteria, TRIBAL_ADVANTAGES, ADVANTAGE_LABELS } from "./advantages.mjs";

function build(c) {
  const q = qset();
  q.add("is_tribal", noul(
    "This excerpt is a tribal council, where the host questions the castaways and votes are read aloud."
  ));
  q.add("votes_were_read", noul("The host read votes aloud at this tribal council."));
  q.add("revote_occurred", noul(
    "The first vote ended in a tie and the castaways voted a second time at this tribal council."
  ));
  q.add("any_advantage_played", noul(
    "At least one castaway played an idol or advantage at this tribal council. A shot in the dark does not count."
  ));
  q.add("any_shot_in_the_dark_played", noul(
    "At least one castaway played their shot in the dark at this tribal council."
  ));
  q.add("exit_method", choice("How was the castaway who left the game at this tribal council decided?", {
    votes: "by the votes read aloud, including a revote after a tie",
    rock_draw: "by drawing rocks after a deadlocked vote",
    fire_making: "by losing a fire-making challenge",
    other: "they left some other way, such as quitting or being removed from the game",
    none: "no castaway left the game at this tribal council",
  }));

  for (const name of withCanaries(c.cast, c)) {
    const k = keyOf(name);
    const at = `attended_${k}`;
    q.add(at, noul(
      `${name} was present at this tribal council. Being mentioned or talked about by someone who is present does not count.`
    ));
    q.add(`received_votes_${k}`, noul(
      `At least one vote with ${name}'s name on it was read aloud at this tribal council, including votes that did not count because of an idol, advantage, or shot in the dark. Being discussed as a possible target does not count.`
    ), at);
    q.add(`safe_${k}`, noul(
      `${name} was safe from being voted out at this tribal council. This includes winning individual immunity before tribal council, and gaining safety during tribal council by playing an idol, an advantage, or a successful shot in the dark.`
    ), at);
    q.add(`torch_${k}`, noul(
      `The host told ${name} to bring their torch, or snuffed ${name}'s torch, at this tribal council.`
    ), at);
    q.add(`advantage_played_by_${k}`, noul(
      `${name} played an idol or advantage at this tribal council. A shot in the dark does not count. Talking about an advantage, or holding one without playing it, does not count.`
    ), at);
    q.add(`advantage_played_on_${k}`, noul(
      `An idol or advantage was played on ${name}'s behalf at this tribal council, making votes against ${name} not count. A shot in the dark does not count.`
    ), at);
    q.add(`advantage_effective_${k}`, noul(
      `${name} played an idol or advantage at this tribal council that changed who went home: had it not been played, a different castaway would have left the game. If it cancelled the votes against a castaway who received the most votes, or tied for the most votes, it counts as changing the outcome. Playing an idol or advantage that made no difference to who went home does not count. A shot in the dark does not count.`
    ), `advantage_played_by_${k}`);
    q.add(`advantage_kind_${k}`, choice(
      `What kind of idol or advantage did ${name} play at this tribal council?`,
      advantageCriteria(TRIBAL_ADVANTAGES)
    ), `advantage_played_by_${k}`);
    q.add(`shot_in_the_dark_played_${k}`, noul(
      `${name} played their shot in the dark at this tribal council. Mentioning or considering the shot in the dark without playing it does not count.`
    ), at);
  }
  return q;
}

export default {
  id: "tribal",
  events: ["elim", "advPlay", "badAdvPlay"],
  start: phrases([
    "i'll go tally",
    "once the votes are read",
    "time to vote",
    "let's get to the vote",
    "going on back at camp",
    "happening back at camp",
    "like back at camp",
    "things back at camp",
    "life back at camp",
    "what are you feeling",
    "bring in the members",
  ]),
  require: phrases([
    "i'll go tally",
    "i'll read the votes",
    "let's read the votes",
    "first vote",
    "that's one vote",
    "once the votes are read",
  ], { exact: true }),
  end: phrases(["the tribe has spoken", "grab your torch", "bring me your torch"]),
  maxSpan: 900,
  build,
  labels: { "advantage_kind_*": ADVANTAGE_LABELS },
  templates: [
    {
      "pair_{castaway}_{target}": noul(
        "{castaway} played an idol or advantage on {target}'s behalf at this tribal council. Playing it on their own behalf counts when {castaway} and {target} are the same person."
      ),
    },
  ],
};
