import { noul, keyOf, qset, withCanaries } from "./helpers.ts";
import { phrases } from "../lib/match.ts";
import { draft, gate, names } from "../lib/derive.ts";
import type { Context, Outcome, Reader, SegmentDef } from "../lib/types/index.ts";

function derive(r: Reader): Outcome {
  const g = gate(r, "notable_event");
  if (!g.open) return { detected: g.detected, events: [] };
  const who = r.people("involves_");
  const what = r.yes("is_journey") ? "Journey" : "Notable event";
  return {
    detected: g.detected,
    events: [
      draft("otherNotes", {
        label: "Other Notes",
        confidence: g.detected,
        people: who.yes,
        notes: [`${what}: ${names(who.yes) || "?"}`],
        // Body text is only ever a draft
        unresolved: [...g.doubt, { field: "notes", reason: "drafted, review the wording" }],
      }),
    ],
  };
}

function build(c: Context) {
  const q = qset();
  q.add("notable_event", noul(
    "Something happened in this excerpt that a Survivor fantasy league would want recorded even though it awards no points — a journey, a summit, a condition imposed on a castaway, or a game twist."
  ));
  q.add("is_journey", noul(
    "One or more castaways were sent away from camp on a journey, to exile, or to a separate location in this excerpt."
  ));
  q.add("castaways_chose", noul(
    "The castaways themselves chose who would go, rather than the host or the game assigning it."
  ));
  q.add("one_person_only", noul("Exactly one castaway was sent, not a group."));
  q.add("volunteered", noul(
    "The castaway who went volunteered themselves, rather than being chosen by the others."
  ));
  for (const name of withCanaries(c.cast, c))
    q.add(`involves_${keyOf(name)}`, noul(
      `${name} is directly involved in this event. Being mentioned, or talking about it in an interview, does not count.`
    ), "notable_event");
  return q;
}

const journey: SegmentDef = {
  id: "journey",
  events: ["otherNotes"],
  start: phrases([
    "go on a journey",
    "going on a journey",
    "sent on a journey",
    "gone on a journey",
    "on a journey for",
    "choose one person",
    "choose one castaway",
    "choose someone",
    "choose somebody",
    "welcome to exile",
    "welcome to survivor exile",
    "sent to exile",
    "going to exile",
    "go to exile",
    "one of you will not",
    "open the envelope",
    "open the next envelope",
    "read the sign",
    "read this sign",
    "summit",
    "risk it",
    "risk your vote",
  ]),
  end: phrases(["grab your stuff", "head out", "head back", "good luck", "back to camp"]),
  maxSpan: 240,
  build,
  derive,
};

export default journey;
