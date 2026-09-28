import { noul, keyOf, qset, withCanaries } from "./helpers.ts";
import { phrases } from "../lib/match.ts";
import { THRESHOLDS, draft, fillTemplate, followupCandidates, gate, names, pick } from "../lib/derive.ts";
import type { Context, Outcome, Reader, SegmentDef, Template } from "../lib/types/index.ts";

const GAVE_TO: Template = {
  "gave_{giver}_to_{receiver}": noul("{giver} gave or offered an idol, advantage, or shot in the dark to {receiver}."),
};

// Offers count: over-flagging is a cheap reject on the card, a miss is not
const HANDED_OFF = "advantage_handed_off|sitd_handed_off";

function build(c: Context) {
  const q = qset();
  q.add("advantage_handed_off", noul(
    "One castaway gives an idol or advantage to another castaway to keep in this excerpt. Offering is an advantage or idol is enough, offering shot in the dark is not. Shot in the Dark is not an advantage. Playing an idol on someone's behalf at tribal council does not count."
  ));
  q.add("sitd_handed_off", noul(
    "One castaway gives their shot in the dark to another castaway to keep in this excerpt. Offering shot in the dark is enough, offering an advantage or idol is not. Playing a shot in the dark at tribal council does not count."
  ));
  for (const name of withCanaries(c.cast, c)) {
    const k = keyOf(name);
    q.add(`gave_${k}`, noul(`${name} gave or offered an idol, advantage, or shot in the dark to another castaway.`), HANDED_OFF);
    q.add(`received_${k}`, noul(`${name} was given or offered an idol, advantage, or shot in the dark by another castaway.`), HANDED_OFF);
  }
  return q;
}

function derive(r: Reader): Outcome {
  const sitd = (r.p("sitd_handed_off") ?? 0) > (r.p("advantage_handed_off") ?? 0);
  const g = gate(r, sitd ? "sitd_handed_off" : "advantage_handed_off");
  if (!g.open) return { detected: g.detected, events: [] };
  const givers = r.people("gave_");
  const receivers = r.people("received_");
  const pairKey = (a: string, b: string) => `gave_${keyOf(a)}_to_${keyOf(b)}`;
  const pairs = givers.plausible.flatMap((gv) =>
    receivers.plausible
      .map((rc) => ({ giver: gv, receiver: rc, p: r.p(pairKey(gv.name, rc.name)) }))
      .filter((x) => x.p != null && x.p >= THRESHOLDS.yes)
  );
  // Only one way to pair one giver with one receiver
  if (!pairs.length && givers.yes.length === 1 && receivers.yes.length === 1)
    pairs.push({ giver: givers.yes[0], receiver: receivers.yes[0], p: null });

  const what = sitd ? "their shot in the dark" : "an idol or advantage";
  const events = pairs.length
    ? pairs.map(({ giver, receiver }) =>
      draft("otherNotes", {
        label: "Other Notes",
        confidence: g.detected,
        people: [giver, receiver],
        notes: [`${giver.name} gave or offered ${receiver.name} ${what}`],
        unresolved: g.doubt,
      })
    )
    : [
      draft("otherNotes", {
        label: "Other Notes",
        confidence: g.detected,
        notes: [`${names(givers.plausible) || "?"} gave or offered ${names(receivers.plausible) || "?"} ${what}`],
        unresolved: [...g.doubt, pick("giver", givers, "who gave it"), pick("receiver", receivers, "who received it")],
      }),
    ];
  return {
    detected: g.detected,
    events,
    followups: fillTemplate(GAVE_TO, { giver: followupCandidates(givers), receiver: followupCandidates(receivers) }),
  };
}

const handoff: SegmentDef = {
  id: "handoff",
  events: ["otherNotes"],
  start: phrases([
    "give you my idol",
    "give you my advantage",
    "give you my shot in the dark",
    "give you the idol",
    "give him my idol",
    "give her my idol",
    "gave him my idol",
    "gave her my idol",
    "gave them my idol",
    "hand you my idol",
    "handed him my idol",
    "handed her my idol",
    "hand over my idol",
    "give it to you",
    "gave it to him",
    "gave it to her",
    "give this to you",
    "hand it to you",
    "idol is yours",
    "advantage is yours",
    "idol for you",
    "advantage for you",
  ]),
  maxSpan: 120,
  build,
  derive,
  templates: [
    GAVE_TO,
  ],
};

export default handoff;
