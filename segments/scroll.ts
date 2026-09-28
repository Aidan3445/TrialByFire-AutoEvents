import { rx, noul, choice, keyOf, qset, withCanaries } from "./helpers.ts";
import { ADVANTAGES, advantageCriteria, ADVANTAGE_LABELS, type AdvantageKey } from "./advantages.ts";
import { phrases } from "../lib/match.ts";
import { choiceLabel, draft, gate, names, pick } from "../lib/derive.ts";
import type { Context, Outcome, Reader, SegmentDef } from "../lib/types/index.ts";

function derive(r: Reader): Outcome {
  const g = gate(r, "is_scroll_reading");
  if (!g.open) return { detected: g.detected, events: [] };
  const holder = r.people("holder_");
  const type = r.choice("advantage_type")?.value;
  const kind = choiceLabel(r, "advantage_type");
  const unresolved = [...g.doubt, ...(holder.yes.length ? [] : [pick("references", holder, "who found it")])];
  const who = names(holder.yes) || "?";
  const note = (text: string) =>
    draft("otherNotes", { label: "Other Notes", confidence: g.detected, people: holder.yes, notes: [text], unresolved });

  // Neither is an advantage for scoring
  if (type === "clue_only") return { detected: g.detected, events: [note(`${who} found a clue to an advantage`)] };
  if (type === "shot_in_the_dark") return { detected: g.detected, events: [note(`${who} found a shot in the dark`)] };

  const label = kind.label ?? "Advantage";
  if (r.is("advantage_taken") === "no") return { detected: g.detected, events: [note(`${who} found ${label} and left it`)] };
  // A beware scores later, when the completion note makes it usable
  if (r.is("grants_usable_power") === "no")
    return { detected: g.detected, events: [note(`${who} found ${label}, not usable yet`)] };

  const doubts = [...unresolved, ...kind.unresolved];
  if (type === "novel") doubts.push({ field: "label", reason: "new advantage type: name it" });
  for (const key of ["advantage_taken", "grants_usable_power"])
    if (r.is(key) === "unsure") doubts.push({ field: key, reason: `${key} ${r.p(key)}` });
  return {
    detected: g.detected,
    events: [
      draft("advFound", {
        label,
        labelConfidence: kind.confidence,
        confidence: g.detected,
        people: holder.yes,
        unresolved: doubts,
      }),
    ],
  };
}

function build(c: Context) {
  const q = qset();
  q.add("is_scroll_reading", noul(
    "Someone reads aloud the text of a note, scroll, or parchment describing an idol or advantage in this excerpt. The host confirming an idol played at tribal council does not count. A castaway recalling a note from an earlier episode does not count."
  ));
  q.add("grants_usable_power", noul(
    "The text read aloud grants a power the holder can use as of now. A clue pointing toward a future advantage does not count. A note imposing a task, condition, or cost before the power becomes usable does not count."
  ), "is_scroll_reading");
  q.add("advantage_taken", noul(
    "The castaway who found the note kept the idol or advantage. Leaving it behind or putting it back does not count."
  ), "is_scroll_reading");
  q.add("advantage_type", choice("What kind of advantage is described?", {
    ...advantageCriteria(Object.keys(ADVANTAGES) as AdvantageKey[]),
    shot_in_the_dark: "a shot in the dark",
    clue_only: "only a clue or directions toward an advantage, not the advantage itself",
  }), "is_scroll_reading");
  for (const name of withCanaries(c.cast, c))
    q.add(`holder_${keyOf(name)}`, noul(
      `${name} is the castaway who found or earned this advantage in this excerpt. Being told about it, or having found it in an earlier episode, does not count.`
    ), "is_scroll_reading");
  return q;
}

const scroll: SegmentDef = {
  id: "scroll",
  events: ["advFound", "otherNotes"],
  start: phrases([
    "congratulations, you have found",
    "you have found a hidden immunity idol",
    "you have found an idol",
    "you have found an advantage",
    "this is a hidden immunity idol",
    "this is an idol",
    "this is an advantage",
    "this is a beware",
    "beware",
    "if you choose to",
    "this advantage expires",
    "this idol expires",
    "this idol is good",
    "this advantage is good",
    "this idol can be used",
    "good through the final",
    "good until the final",
    "valid through the final",
    "valid until the final",
    "read the note",
    "read the scroll",
    "read the parchment",
    "what does it say",
  ]),
  // "read the vote(s)" is one letter off "read the note"
  startNot: rx(["if anybody has", "now would be the time", "read\\s*the\\s*votes?\\b"]),
  maxSpan: 90,
  build,
  derive,
  labels: { advantage_type: ADVANTAGE_LABELS },
};

export default scroll;
