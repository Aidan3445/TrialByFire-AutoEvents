import { noul, keyOf, qset, withCanaries } from "./helpers.mjs";
import { phrases } from "../lib/match.mjs";

function build(c) {
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

export default {
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
};
