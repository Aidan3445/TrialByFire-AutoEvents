import { noul, choice, keyOf, qset, withCanaries } from "./helpers.ts";
import { advantageCriteria, TRIBAL_ADVANTAGES, ADVANTAGE_LABELS } from "./advantages.ts";
import { phrases } from "../lib/match.ts";
import { THRESHOLDS, check, choiceLabel, draft, fillTemplate, followupCandidates, gate, names, pick } from "../lib/derive.ts";
import type {
  BaseEventName,
  Check,
  Context,
  DraftEvent,
  Outcome,
  Reader,
  Scored,
  SegmentDef,
  Template,
  Unresolved,
} from "../lib/types/index.ts";

const PAIR: Template = {
  "pair_{castaway}_{target}": noul(
    "{castaway} played an idol or advantage on {target}'s behalf at this tribal council. Playing it on their own behalf counts when {castaway} and {target} are the same person."
  ),
};

const EXITS: Record<string, [BaseEventName, string | null]> = {
  votes: ["elim", null],
  rock_draw: ["elim", "Rock Draw"],
  fire_making: ["noVoteExit", "Lost Fire Making"],
  other: ["noVoteExit", null],
};

function build(c: Context) {
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

function deriveExit(r: Reader, doubt: Unresolved[], events: DraftEvent[], checks: Check[]) {
  const method = r.choice("exit_method");
  if (!method || method.value === "none") return;
  const [eventName, label] = EXITS[method.value] ?? ["elim", null];
  const torch = r.people("torch_");
  const unresolved = [...doubt];
  if (method.confidence < THRESHOLDS.yes)
    unresolved.push({
      field: "exit_method",
      reason: `how they left is unsure (${method.value} ${method.confidence})`,
      options: Object.entries(method.probabilities).map(([value, confidence]) => ({ value, confidence })),
    });
  // Voted out vs blindside is a judgement call, left to the admin by design
  if (method.value === "votes")
    unresolved.push({ field: "label", reason: "manual", options: [{ value: "Voted Out" }, { value: "Blindside" }] });
  if (method.value === "other")
    unresolved.push({
      field: "label",
      reason: "left without a vote",
      options: [{ value: "Med Evacuation" }, { value: "Quit" }, { value: "Removed" }],
    });
  if (torch.yes.length !== 1)
    unresolved.push(pick("references", torch, torch.yes.length ? "more than one torch" : "who left is unclear"));
  events.push(draft(eventName, { label, confidence: method.confidence, people: torch.yes, unresolved }));

  const received = r.people("received_votes_");
  const safe = r.people("safe_");
  const attended = r.people("attended_");
  const has = (list: Scored[], name: string) => list.some((s) => s.name === name);
  for (const { name } of torch.yes) {
    const p = (prefix: string) => r.p(`${prefix}${keyOf(name)}`);
    if (method.value === "votes")
      checks.push(check("eliminated castaway received votes", has(received.yes, name), `${name} received_votes ${p("received_votes_")}`));
    checks.push(check("eliminated castaway was not safe", !has(safe.yes, name), `${name} safe ${p("safe_")}`));
    // Attendance is weak for anyone the window never mentions
    checks.push(check("eliminated castaway attended", has(attended.yes, name), `${name} attended ${p("attended_")}`, true));
  }
}

function deriveAdvantages(r: Reader, events: DraftEvent[], checks: Check[]) {
  const players = r.people("advantage_played_by_");
  const targets = r.people("advantage_played_on_");
  const pairKey = (a: string, b: string) => `pair_${keyOf(a)}_${keyOf(b)}`;
  const pairsAnswered = players.plausible.some((pl) => targets.plausible.some((t) => r.p(pairKey(pl.name, t.name)) != null));

  for (const player of players.yes) {
    const k = keyOf(player.name);
    const kind = choiceLabel(r, `advantage_kind_${k}`);
    const kindValue = r.choice(`advantage_kind_${k}`)?.value;
    let on = targets.plausible
      .map((t) => ({ name: t.name, p: r.p(pairKey(player.name, t.name)) ?? 0 }))
      .filter((t) => t.p >= THRESHOLDS.yes);
    // Only one way to pair one player with one target
    if (!pairsAnswered && players.yes.length === 1 && targets.yes.length === 1) on = targets.yes;

    const unresolved = [...kind.unresolved];
    if (!on.length) unresolved.push(pick("played on", targets, "who it was played on is unclear"));

    const eff = r.p(`advantage_effective_${k}`);
    const effVerdict = r.is(`advantage_effective_${k}`);
    // An idol that cancelled no votes cannot have changed who went home
    const cancelledNothing =
      kindValue === "idol" && on.length > 0 && on.every((t) => r.is(`received_votes_${keyOf(t.name)}`) === "no");
    let eventName: BaseEventName = effVerdict === "yes" ? "advPlay" : "badAdvPlay";
    if (effVerdict === "unsure" || effVerdict == null) {
      eventName = cancelledNothing || (eff ?? 0) < 0.5 ? "badAdvPlay" : "advPlay";
      unresolved.push({
        field: "eventName",
        reason: `effectiveness unsure (${eff})${cancelledNothing ? `; ${names(on)} received no votes` : ""}`,
        options: [
          { value: "advPlay", confidence: eff ?? undefined },
          { value: "badAdvPlay", confidence: eff == null ? undefined : Math.round((1 - eff) * 100) / 100 },
        ],
      });
    } else if (kindValue !== "idol")
      unresolved.push({ field: "eventName", reason: "non-idol advantage: effectiveness is a manual call" });
    if (effVerdict === "yes" && cancelledNothing)
      checks.push(check("effective idol cancelled votes", false, `${names(on)} received no votes`));

    events.push(
      draft(eventName, {
        label: kind.label,
        labelConfidence: kind.confidence,
        confidence: eff,
        people: [player],
        notes: [`${player.name} played ${kind.label ?? "an advantage"} on ${on.length ? names(on) : "?"}`],
        unresolved,
      })
    );
  }

  if (r.yes("any_advantage_played") && !players.yes.length)
    events.push(
      draft("advPlay", { unresolved: [pick("references", players, "an advantage was played; by whom is unclear")] })
    );

  return fillTemplate(PAIR, { castaway: followupCandidates(players), target: followupCandidates(targets) });
}

function derive(r: Reader): Outcome {
  const g = gate(r, "is_tribal");
  if (!g.open) return { detected: g.detected, events: [] };
  const events: DraftEvent[] = [];
  const checks: Check[] = [];
  deriveExit(r, g.doubt, events, checks);
  const followups = deriveAdvantages(r, events, checks);
  // Tracked, never scored
  for (const s of r.people("shot_in_the_dark_played_").yes)
    events.push(draft("otherNotes", { label: "Other Notes", people: [s], notes: [`${s.name} played their shot in the dark`] }));
  return { detected: g.detected, events, checks, followups };
}

const tribal: SegmentDef = {
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
  derive,
  labels: { "advantage_kind_*": ADVANTAGE_LABELS },
  templates: [PAIR],
};

export default tribal;
