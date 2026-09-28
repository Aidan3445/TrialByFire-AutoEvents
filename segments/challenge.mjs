import { rx, noul, choice, keyOf, cap, qset, withCanaries, RULES_TALK } from "./helpers.mjs";
import { phrases } from "../lib/match.mjs";

const COLOURS = ["blue", "red", "yellow", "green", "orange", "purple", "black", "white", "pink"];

const coloursIn = (text) => COLOURS.filter((c) => new RegExp(`\\b${c}\\b`, "i").test(text));

function build(c, info) {
  const q = qset();
  q.add("is_challenge", noul(
    "This excerpt is a challenge being run at the challenge area. Tribal council, camp conversation, and confessionals are not challenges."
  ));
  q.add("immunity_at_stake", noul("Immunity is awarded to someone in this challenge."));
  q.add("reward_at_stake", noul("A reward is awarded to someone in this challenge."));
  q.add("multiple_winners", noul(
    "More than one castaway or team is awarded the same prize in this challenge."
  ));
  q.add("field_kind", choice("Do castaways compete as individuals or as teams in this challenge?", {
    individual: "each castaway competes for themselves",
    team: "castaways compete as members of a team or tribe",
  }));
  q.add("grouping", choice("How are the castaways grouped for this challenge?", {
    existing_tribes: "they compete in the tribes they already belong to",
    new_teams: "they are drawn, picked, or assigned into teams just for this challenge",
    none: "they are not divided into any groups",
  }));
  q.add("team_count", choice("How many tribes or teams compete against each other in this challenge?", {
    two: "exactly two tribes or teams",
    three_or_more: "three or more tribes or teams",
    no_teams: "castaways do not compete as tribes or teams",
  }));

  const placement = (label, k, gate) => {
    q.add(`first_${k}`, noul(
      `${label} finished in first place in this challenge. Competing well, leading partway through, or nearly winning does not count.`
    ), gate);
    q.add(`second_${k}`, noul(
      `${label} finished in second place in this challenge. Finishing first does not count. Finishing last does not count.`
    ), "team_count=three_or_more");
  };
  for (const t of c.tribes) placement(t, keyOf(t));

  const tribeKeys = new Set(c.tribes.map(keyOf));
  for (const colour of info.colours.filter((x) => !tribeKeys.has(keyOf(x)))) {
    const k = keyOf(colour);
    const Label = cap(colour);
    q.add(`team_exists_${k}`, noul(
      `A team called ${Label} competed in this challenge. A passing mention of the colour ${colour} that is not a team name does not count.`
    ));
    placement(Label, k, `team_exists_${k}`);
    for (const name of withCanaries(c.cast, c))
      q.add(`on_${k}_${keyOf(name)}`, noul(`${name} competed for ${Label} in this challenge.`),
        `team_exists_${k}&grouping=new_teams`);
  }

  for (const name of withCanaries(c.cast, c)) {
    const k = keyOf(name);
    q.add(`won_immunity_${k}`, noul(
      `${name} won individual immunity in this challenge. Competing well, leading, or nearly winning does not count. Immunity won in an earlier episode does not count. Being on a tribe or team that won does not count.`
    ));
    q.add(`won_reward_${k}`, noul(
      `${name} won the reward in this challenge as an individual. Competing well, leading, or nearly winning does not count. Being on a tribe or team that won, or being chosen to join the winner, does not count.`
    ));
    q.add(`brought_on_reward_${k}`, noul(
      `${name} was chosen by the reward winner to share the reward. The winner themselves does not count.`
    ), "won_reward_*&field_kind=individual");
  }
  return q;
}

export default {
  id: "challenge",
  events: ["indivWin", "indivReward", "tribe1st", "tribe2nd"],
  start: phrases([
    "come on in",
    "immunity is back up for grabs",
    "once again immunity",
    "want to know what you're playing for",
    "for today's challenge",
    "today's reward challenge",
    "today's immunity challenge",
    "shall we get to",
    "survivors ready",
    "draw for spots",
    "draw for teams",
    "draw for partners",
    "schoolyard pick",
  ]),
  require: phrases([
    "wins immunity",
    "win immunity",
    "wins individual immunity",
    "wins reward",
    "win reward",
    "wins it",
    "win it",
    "immunity is yours",
    "reward is yours",
    "you're all safe",
    "winner",
    "that's it, it's over",
    "'s done it",
    "has done it",
  ], { exact: true }),
  requireNot: rx(RULES_TALK),
  end: phrases([
    "grab your stuff",
    "head back to camp",
    "head out",
    "got nothing for you",
    "nothing for you",
    "see you at tribal",
  ]),
  maxSpan: 900,
  // Arrival and rules often sit on the far side of an ad break from the result
  mergeIncomplete: true,
  build,
  // One-off team names come from the segment text; the placeholder keeps
  // team questions inside the question set version hash
  inspect: (text) => ({ colours: coloursIn(text) }),
  placeholder: { colours: ["{label}"] },
};
