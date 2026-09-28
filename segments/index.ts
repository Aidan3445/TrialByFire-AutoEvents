import journey from "./journey.ts";
import tribeUpdate from "./tribeUpdate.ts";
import challenge from "./challenge.ts";
import tribal from "./tribal.ts";
import fire from "./fire.ts";
import scroll from "./scroll.ts";
import handoff from "./handoff.ts";
import exit from "./exit.ts";
import redemption from "./redemption.ts";
import finale from "./finale.ts";
import title from "./title.ts";
import type { Context, SegmentDef } from "../lib/types/index.ts";

export const SEGMENTS: SegmentDef[] = [
  journey, tribeUpdate, challenge, tribal, fire, scroll, handoff, exit, redemption, finale, title,
];

/** Segment definitions with any context-dependent anchors (e.g. the title) filled in. */
export const segmentsFor = (ctx: Context): SegmentDef[] =>
  SEGMENTS.map((def) => (def.withContext ? { ...def, ...def.withContext(ctx) } : def));
