import journey from "./journey.mjs";
import tribeUpdate from "./tribeUpdate.mjs";
import challenge from "./challenge.mjs";
import tribal from "./tribal.mjs";
import fire from "./fire.mjs";
import scroll from "./scroll.mjs";
import handoff from "./handoff.mjs";
import exit from "./exit.mjs";
import redemption from "./redemption.mjs";
import finale from "./finale.mjs";
import title from "./title.mjs";

export const SEGMENTS = [journey, tribeUpdate, challenge, tribal, fire, scroll, handoff, exit, redemption, finale, title];

/** Segment definitions with any context-dependent anchors (e.g. the title) filled in. */
export const segmentsFor = (ctx) =>
  SEGMENTS.map((def) => (def.withContext ? { ...def, ...def.withContext(ctx) } : def));
