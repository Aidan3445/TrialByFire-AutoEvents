import { rx, noul, choice, keyOf, cap, qset, withCanaries, RULES_TALK } from "./helpers.ts";
import { phrases } from "../lib/match.ts";
import { check, draft, gate, names, pick } from "../lib/derive.ts";
import type { Check, Context, DraftEvent, Outcome, Reader, Scored, SegmentDef, Unresolved } from "../lib/types/index.ts";

const COLOURS = ["blue", "red", "yellow", "green", "orange", "purple", "black", "white", "pink"];

const coloursIn = (text: string) => COLOURS.filter((c) => new RegExp(`\\b${c}\\b`, "i").test(text));

/** One-off team names found in the segment text. */
interface ChallengeInfo {
  colours: string[];
}

function build(c: Context, info: ChallengeInfo) {
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

  const placement = (label: string, k: string, gate?: string) => {
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

/** Label from what was at stake; a combined challenge is one event, not two. */
function prize(r: Reader, kind: "Individual" | "Tribe") {
  const imm = r.p("immunity_at_stake") ?? 0;
  const rew = r.p("reward_at_stake") ?? 0;
  const immunity = imm >= 0.5;
  const reward = rew >= 0.5;
  const label = immunity && reward ? `${kind} Immunity and Reward` : immunity ? `${kind} Immunity` : `${kind} Reward`;
  const certainty = Math.min(Math.max(imm, 1 - imm), Math.max(rew, 1 - rew));
  const unresolved: Unresolved[] =
    r.is("immunity_at_stake") === "unsure" || r.is("reward_at_stake") === "unsure"
      ? [
          {
            field: "label",
            reason: `prize unsure (immunity ${imm}, reward ${rew})`,
            options: [`${kind} Immunity and Reward`, `${kind} Immunity`, `${kind} Reward`].map((value) => ({ value })),
          },
        ]
      : [];
  return { immunity, reward, label, certainty, unresolved };
}

interface Team {
  name: string;
  key: string;
  /** Existing tribes are app references; one-off teams reference their members. */
  tribe: boolean;
  members: Scored[];
}

function teamsOf(r: Reader, c: Context): Team[] {
  if (r.choice("grouping")?.value !== "new_teams")
    return c.tribes.map((t) => ({ name: t, key: keyOf(t), tribe: true, members: [] }));
  return r
    .keys(/^team_exists_/)
    .filter((k) => r.yes(k))
    .map((k) => {
      const key = k.slice("team_exists_".length);
      return { name: cap(key), key, tribe: false, members: r.people(`on_${key}_`).yes };
    });
}

function deriveIndividual(r: Reader, doubt: Unresolved[], events: DraftEvent[], checks: Check[]) {
  const pr = prize(r, "Individual");
  const winners = r.people(pr.immunity ? "won_immunity_" : "won_reward_");
  events.push(
    draft(pr.immunity ? "indivWin" : "indivReward", {
      label: pr.immunity ? pr.label : "Individual Reward",
      labelConfidence: pr.certainty,
      confidence: r.p("is_challenge"),
      people: winners.yes,
      unresolved: [...doubt, ...pr.unresolved, ...(winners.yes.length ? [] : [pick("references", winners, "winner unclear")])],
    })
  );
  if (pr.reward && winners.yes.length) {
    // The winner scores; who they took along is only a note
    const brought = r.people("brought_on_reward_");
    if (brought.plausible.length)
      events.push(
        draft("otherNotes", {
          label: "Other Notes",
          people: brought.yes,
          notes: [`${names(winners.yes)} brought ${names(brought.yes) || "?"} on the reward`],
          unresolved: brought.unsure.length ? [pick("references", brought, "who went on the reward")] : [],
        })
      );
  }
  const many = r.is("multiple_winners");
  if (many === "yes" || many === "no")
    checks.push(
      check("winner count matches multiple_winners", (winners.yes.length > 1) === (many === "yes"), `${winners.yes.length} winners, multiple_winners ${r.p("multiple_winners")}`, true)
    );
}

function deriveTeams(r: Reader, c: Context, doubt: Unresolved[], events: DraftEvent[], checks: Check[]) {
  const pr = prize(r, "Tribe");
  const teams = teamsOf(r, c);
  const refs = (t: Team) => (t.tribe ? { tribes: [t.name] } : { people: t.members });
  const placed = (place: "first" | "second", eventName: "tribe1st" | "tribe2nd") => {
    const hits = teams.filter((t) => r.yes(`${place}_${t.key}`));
    for (const t of hits)
      events.push(
        draft(eventName, {
          label: pr.label,
          labelConfidence: pr.certainty,
          confidence: r.p(`${place}_${t.key}`),
          ...refs(t),
          notes: t.tribe ? [] : [`${t.name} team: ${names(t.members)}`],
          unresolved: [...doubt, ...pr.unresolved],
        })
      );
    if (!hits.length && teams.length)
      events.push(
        draft(eventName, {
          label: pr.label,
          unresolved: [
            {
              field: "references",
              reason: `${place} place unclear`,
              options: teams.map((t) => ({ value: t.name, confidence: r.p(`${place}_${t.key}`) ?? undefined })),
            },
          ],
        })
      );
  };
  placed("first", "tribe1st");
  // Second place only scores with three or more teams; with two it is last
  if (r.choice("team_count")?.value === "three_or_more") placed("second", "tribe2nd");

  if (teams.some((t) => !t.tribe)) {
    const count = new Map<string, number>();
    for (const t of teams) for (const m of t.members) count.set(m.name, (count.get(m.name) ?? 0) + 1);
    const twice = [...count].filter(([, n]) => n > 1).map(([name]) => name);
    const missing = c.cast.filter((name) => !count.has(name));
    checks.push(check("nobody on two teams", !twice.length, twice.join(", ") || "ok"));
    // Uneven teams mean someone sits out, so a gap is only a warning
    checks.push(check("every castaway on a team", !missing.length, missing.join(", ") || "ok", true));
  }
}

function derive(r: Reader, c: Context): Outcome {
  const g = gate(r, "is_challenge");
  if (!g.open) return { detected: g.detected, events: [] };
  const events: DraftEvent[] = [];
  const checks: Check[] = [];
  if (r.choice("field_kind")?.value === "team") deriveTeams(r, c, g.doubt, events, checks);
  else deriveIndividual(r, g.doubt, events, checks);
  return { detected: g.detected, events, checks };
}

const challenge: SegmentDef<ChallengeInfo> = {
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
  derive,
  // One-off team names come from the segment text; the placeholder keeps
  // team questions inside the question set version hash
  inspect: (text) => ({ colours: coloursIn(text) }),
  placeholder: { colours: ["{label}"] },
};

export default challenge;
