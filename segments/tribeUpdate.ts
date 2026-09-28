import { noul, choice, keyOf, qset, withCanaries } from "./helpers.ts";
import { phrases } from "../lib/match.ts";
import type { Context, SegmentDef } from "../lib/types/index.ts";

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
  labels: { update_kind: UPDATE_KINDS },
};

export default tribeUpdate;
