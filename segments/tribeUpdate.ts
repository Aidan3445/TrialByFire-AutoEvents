import { noul, choice, keyOf, qset, withCanaries } from "./helpers.ts";
import { phrases } from "../lib/match.ts";
import { check, choiceLabel, draft, gate } from "../lib/derive.ts";
import type { Context, Outcome, Reader, SegmentDef } from "../lib/types/index.ts";

function derive(r: Reader, c: Context): Outcome {
  const g = gate(r, "tribe_change_occurred");
  if (!g.open) return { detected: g.detected, events: [] };
  const kind = choiceLabel(r, "update_kind");
  const base = { label: kind.label, labelConfidence: kind.confidence, confidence: g.detected };
  // The S51 premiere drew buffs without saying who went where: hand over a picker
  if (!r.yes("assignments_stated"))
    return {
      detected: g.detected,
      events: [
        draft("tribeUpdate", {
          ...base,
          tribes: c.tribes.filter((t) => r.yes(`tribe_exists_${keyOf(t)}`)),
          unresolved: [...g.doubt, ...kind.unresolved, { field: "references", reason: "assignments not stated: pick members" }],
        }),
      ],
    };
  const members = c.tribes.map((t) => ({ tribe: t, people: r.people(`on_${keyOf(t)}_`).yes }));
  const count = new Map<string, number>();
  for (const m of members) for (const s of m.people) count.set(s.name, (count.get(s.name) ?? 0) + 1);
  const twice = [...count].filter(([, n]) => n > 1).map(([name]) => name);
  const missing = c.cast.filter((name) => !count.has(name));
  return {
    detected: g.detected,
    events: members
      .filter((m) => m.people.length)
      .map((m) => draft("tribeUpdate", { ...base, tribes: [m.tribe], people: m.people, unresolved: [...g.doubt, ...kind.unresolved] })),
    checks: [
      check("nobody on two tribes", !twice.length, twice.join(", ") || "ok"),
      check("every castaway on a tribe", !missing.length, missing.join(", ") || "ok"),
    ],
  };
}

const UPDATE_KINDS = {
  starting_tribes: "Starting Tribes",
  swap: "Tribe Swap",
  new_tribes: "New Tribes",
  merge: "Merge Tribe",
};

function build(c: Context) {
  const q = qset();
  q.add("tribe_change_occurred", noul("Castaways were assigned to new tribes in this excerpt."));
  q.add("update_kind", choice<keyof typeof UPDATE_KINDS>("What kind of tribe change happened in this excerpt?", {
    starting_tribes: "castaways were placed into their first tribes at the start of the game",
    swap: "castaways were redistributed among tribes that already existed",
    new_tribes: "castaways were placed into newly created tribes",
    merge: "all remaining castaways were combined into a single tribe",
  }), "tribe_change_occurred");
  q.add("by_buff_draw", noul(
    "The tribe assignments were decided by castaways drawing or picking buffs at random."
  ), "tribe_change_occurred");
  q.add("assignments_stated", noul(
    "The transcript states which specific castaways ended up on which tribe. Announcing that a draw is happening, without naming who went where, does not count."
  ), "tribe_change_occurred");
  for (const t of c.tribes) {
    q.add(`tribe_exists_${keyOf(t)}`, noul(`A tribe called ${t} exists in this excerpt.`));
    for (const name of withCanaries(c.cast, c))
      q.add(`on_${keyOf(t)}_${keyOf(name)}`, noul(
        `${name} is on the ${t} tribe after this assignment. Being considered for a tribe, or being mentioned, does not count.`
      ), "assignments_stated");
  }
  return q;
}

const tribeUpdate: SegmentDef = {
  id: "tribeUpdate",
  events: ["tribeUpdate"],
  start: phrases([
    "drop your buffs",
    "draw for tribes",
    "drawing for tribes",
    "draw for new tribes",
    "draw for your new tribes",
    "new tribes",
    "tribe swap",
    "come get your buff",
    "new buff",
    "new tribe buff",
    "you are merged",
    "you are now merged",
    "you are one tribe",
    "you are all one tribe",
    "we are all one tribe",
    "welcome to the merge",
  ]),
  end: phrases([
    "grab your stuff",
    "head out",
    "your new home",
    "head to camp",
    "head back to camp",
    "head to your new camp",
  ]),
  maxSpan: 240,
  build,
  derive,
  labels: { update_kind: UPDATE_KINDS },
};

export default tribeUpdate;
