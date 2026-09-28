import { rx, noul, keyOf, qset, withCanaries, RULES_TALK } from "./helpers.ts";
import { phrases } from "../lib/match.ts";
import { check, draft, gate, names, pick } from "../lib/derive.ts";
import type { Context, Outcome, Reader, SegmentDef } from "../lib/types/index.ts";

function derive(r: Reader): Outcome {
  const g = gate(r, "fire_challenge_occurred");
  if (!g.open) return { detected: g.detected, events: [] };
  const winner = r.people("fire_win_");
  const competed = r.people("fire_competed_");
  const losers = competed.yes.filter((s) => !winner.yes.some((w) => w.name === s.name));
  return {
    detected: g.detected,
    events: [
      draft("fireWin", {
        label: "Won Fire Making",
        confidence: g.detected,
        people: winner.yes,
        unresolved: [...g.doubt, ...(winner.yes.length === 1 ? [] : [pick("references", winner, "who won fire")])],
      }),
      // Leaving by fire is noVoteExit, never elim: no vote decided it
      draft("noVoteExit", {
        label: "Lost Fire Making",
        confidence: g.detected,
        people: losers,
        unresolved: losers.length === 1 ? [] : [pick("references", competed, "who lost fire")],
      }),
    ],
    checks: [
      check("exactly one fire winner", winner.yes.length === 1, names(winner.yes) || "none"),
      check("winner competed", winner.yes.every((w) => competed.yes.some((s) => s.name === w.name)), names(competed.yes)),
    ],
  };
}

function build(c: Context) {
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

const fire: SegmentDef = {
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
  derive,
};

export default fire;
