import { noul, keyOf, qset, withCanaries } from "./helpers.ts";
import { phrases } from "../lib/match.ts";
import type { Context, SegmentDef } from "../lib/types/index.ts";

function build(c: Context) {
  const q = qset();
  const title = c.title ?? "{TITLE}";
  q.add("title_spoken", noul(
    `A line in this excerpt is the source of the episode title "${title}". The line may be a close paraphrase rather than an exact match.`
  ));
  for (const name of withCanaries(c.cast, c))
    q.add(`title_speaker_${keyOf(name)}`, noul(
      `${name} spoke the line that the episode title "${title}" is drawn from.`
    ), "title_spoken");
  return q;
}

// Triggered by a near match of the episode title itself; the window is the
// lead/tail buffer around the line
const title: SegmentDef = {
  id: "title",
  events: ["spokeEpTitle"],
  start: [],
  // Titles run longer than one caption line
  lookahead: 2,
  maxSpan: 15,
  withContext: (ctx) => ({ start: ctx.title ? phrases([ctx.title]) : [] }),
  build,
};

export default title;
