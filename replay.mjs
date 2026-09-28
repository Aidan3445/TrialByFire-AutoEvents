/**
 * Episode replay harness.
 *
 * Scrolls a captured transcript as if the episode were playing, watches for
 * segment triggers, buffers from start anchor to end anchor, and writes one
 * prompt file per detected segment.
 *
 *   node replay.mjs s51e1.jsonl --episode s51e1
 *
 * Output per segment: s51e1p{n}.jsonl
 *   line 1  {"host": "...", "transcript": "..."}     context
 *   line 2  {"is_...": {...}, ...}                   questions
 *   line 3+ iterative templates, one per line        (handled manually)
 */

import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
const IN = args[0];
const argOf = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const EPISODE = argOf("--episode", (IN || "ep").replace(/\.jsonl$/, ""));
const DEBUG = args.includes("--debug");
const LEAD_S = Number(argOf("--lead", "20")); // buffer before start anchor
const TAIL_S = Number(argOf("--tail", "20")); // buffer after end anchor

if (!IN) {
  console.error("usage: node replay.mjs <cues.jsonl> [--episode NAME] [--lead 20] [--tail 20]");
  console.log("  --episode NAME   episode name for output files (default: cues.jsonl without .jsonl)");
  console.log("  --lead    N      seconds to include before start anchor (default: 20)");
  console.log("  --tail    N      seconds to include after end anchor (default: 19)");
  console.log("  --tribes  A,B,C  comma-separated list of tribe names for challenge/tribeUpdate questions");
  console.log("  --cast    A,B,C  comma-separated list of castaway names for tribal questions");
  console.log("  --audit          print every anchor match in the file, by segment type, then exit");
  process.exit(2);
}

const HOST = "Jeff Probst";

const TRIBES = [];
const tribesArg = argOf("--tribes", "");
const SEASON_TRIBES = tribesArg ? tribesArg.split(",").map((s) => s.trim()) : TRIBES;

const CAST = (argOf("--cast", "") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function loadCues(path) {
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const text = o.text ?? o.caption ?? o.content ?? "";
    if (!text) continue;
    out.push({
      key: o.key ?? String(out.length),
      text: String(text).replace(/\s+/g, " ").trim(),
      start: Number(o.start ?? o.starttime ?? o.startTime ?? out.length),
      end: Number(o.end ?? o.endtime ?? o.endTime ?? out.length + 1),
      boundary: o.boundary ?? null,
      suspect: Boolean(o.suspect),
      duplicate: Boolean(o.duplicate),
      seq: o.seq,
    });
  }
  return out
    .filter((c) => !c.suspect)
    .sort((a, b) => a.start - b.start || (a.seq ?? 0) - (b.seq ?? 0));
}

/** Scroll repeats: same text, near-identical timing, new key. */
function dropScrollRepeats(cues) {
  const out = [];
  let lastText = null;
  let lastStart = null;
  for (const c of cues) {
    const t = c.text.toUpperCase();
    const near = lastStart != null && Math.abs(c.start - lastStart) <= 10;
    if (t && t === lastText && near) continue;
    out.push(c);
    lastText = t;
    lastStart = c.start;
  }
  return out;
}

const rx = (arr) => arr.map((s) => new RegExp(s, "i"));

const SEGMENTS = [
  {
    id: "journey",
    event: "notesOnly",
    start: rx([
      "\\bexile\\b",
      "one person",
      "choose someone",
      "choose one",
      "\\bread it\\b",
      "read the sign",
      "volunteer",
    ]),
    end: rx(["grab your stuff", "head out", "good luck", "let's go"]),
    maxSpan: 240,
  },
  {
    id: "tribeUpdate",
    event: "tribeUpdate",
    start: rx([
      "drop your buffs",
      "draw(ing)? for (your )?(new )?tribes",
      "new tribes",
      "tribe swap",
      "come get your buff",
      "reach in",
    ]),
    end: rx(["grab your stuff", "head out", "your new home", "let's go"]),
    maxSpan: 240,
  },
  {
    id: "challenge",
    event: "tribeWin",
    start: rx([
      "come on in",
      "immunity is back up for grabs",
      "once again,? immunity",
      "want to know what you'?re playing for",
      "for today'?s challenge",
      "today'?s (reward|immunity) challenge",
      "survivors ready",
    ]),
    require: rx([
      "wins? (immunity|reward|it)",
      "(immunity|reward) is yours",
      "you'?re all safe",
      "winner",
      "that'?s it, it'?s over",
    ]),
    end: rx([
      "grab your stuff",
      "head back to camp",
      "got nothing for you",
      "nothing for you",
      "see you at tribal",
    ]),
    maxSpan: 600,
  },
  {
    id: "tribal",
    event: "elim",
    start: rx([
      "i'?ll go tally",
      "once the votes are read",
      "time to vote",
      "let'?s get to the vote",
      "back at camp",
      "what are you feeling",
      "bring in the members",
    ]),
    require: rx(["i'?ll go tally", "first vote", "that'?s one vote", "once the votes are read"]),
    end: rx(["the tribe has spoken", "grab your torch", "bring me your torch"]),
    maxSpan: 900,
  },
];

function findSegments(cues) {
  const found = [];
  for (const def of SEGMENTS) {
    let i = 0;
    while (i < cues.length) {
      if (!def.start.some((r) => r.test(cues[i].text))) {
        i++;
        continue;
      }
      const startCue = cues[i];
      const startPat = def.start.find((r) => r.test(cues[i].text));
      let endIdx = null;
      let requirePat = null, requireCue = null, endPat = null;
      // A segment cannot close until it contains what we need from it. End
      // anchors before that point are ignored -- they are almost always the
      // host describing what is ABOUT to happen.
      let satisfied = !def.require;
      let hitCap = false;
      let j = i + 1;
      for (; j < cues.length; j++) {
        if (cues[j].start - startCue.start > def.maxSpan) {
          hitCap = true;
          break;
        }
        if (!satisfied) {
          const hit = def.require.find((r) => r.test(cues[j].text));
          if (hit) {
            satisfied = true;
            requirePat = hit;
            requireCue = cues[j];
            continue;
          }
        }
        if (satisfied) {
          const hit = def.end.find((r) => r.test(cues[j].text));
          if (hit) {
            endIdx = j;
            endPat = hit;
            break;
          }
        }
      }
      const incomplete = !satisfied;
      const closedBy = endPat
        ? "end anchor"
        : hitCap
          ? "span cap"
          : "end of transcript";
      if (endIdx == null) {
        endIdx = cues.findLastIndex(
          (c) => c.start - startCue.start <= def.maxSpan
        );
        if (endIdx <= i) endIdx = Math.min(i + 40, cues.length - 1);
      }
      found.push({
        def,
        startIdx: i,
        endIdx,
        incomplete,
        startPat, requirePat, requireCue, endPat,
        closedBy,
        endCue: cues[endIdx],
        startTime: startCue.start,
        endTime: cues[endIdx].end,
        trigger: startCue.text.slice(0, 60),
      });
      i = endIdx + 1;
    }
  }
  return mergeOverlapping(found).sort((a, b) => a.startTime - b.startTime);
}

// Merge overlapping triggers for the same segment type
function mergeOverlapping(found) {
  const byType = new Map();
  for (const f of found) {
    const list = byType.get(f.def.id) ?? [];
    list.push(f);
    byType.set(f.def.id, list);
  }
  const out = [];
  for (const list of byType.values()) {
    list.sort((a, b) => a.startIdx - b.startIdx);
    let cur = null;
    for (const f of list) {
      if (cur && f.startIdx <= cur.endIdx) {
        cur.endIdx = Math.max(cur.endIdx, f.endIdx);
        cur.endTime = Math.max(cur.endTime, f.endTime);
        cur.incomplete = cur.incomplete && f.incomplete;
        cur.endReason = f.endReason;
        cur.endDetail = f.endDetail;
        cur.requireHit = cur.requireHit ?? f.requireHit;
      } else {
        if (cur) out.push(cur);
        cur = { ...f };
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

function withBuffer(cues, seg) {
  const lead = seg.startTime - LEAD_S;
  const tail = seg.endTime + TAIL_S;
  const sel = cues.filter((c) => c.start >= lead && c.start <= tail);
  return sel.length ? sel : cues.slice(seg.startIdx, seg.endIdx + 1);
}

function assembleState(sel) {
  return sel
    .map((c, i) => {
      if (i === 0) return c.text;
      if (c.boundary === "topic") return "\n\n" + c.text;
      if (c.boundary === "speaker") return "\n" + c.text;
      return " " + c.text;
    })
    .join("")
    .trim();
}

const noul = (instructions) => ({ type: "noul", instructions });

function journeyQuestions() {
  return {
    is_notesOnly: noul(
      "Something happened in this excerpt that a Survivor fantasy league would want recorded even though it awards no points — a journey, a summit, a condition imposed on a castaway, or a game twist."
    ),
    is_journey: noul(
      "One or more castaways were sent away from camp on a journey, to exile, or to a separate location in this excerpt."
    ),
    castaways_chose: noul(
      "The castaways themselves chose who would go, rather than the host or the game assigning it."
    ),
    one_person_only: noul("Exactly one castaway was sent, not a group."),
    volunteered: noul(
      "The castaway who went volunteered themselves, rather than being chosen by the others."
    ),
  };
}

function tribeUpdateQuestions() {
  const q = {
    is_tribeUpdate: noul("Castaways were assigned to new tribes in this excerpt."),
    by_buff_draw: noul(
      "The tribe assignments were decided by castaways drawing or picking buffs at random."
    ),
    assignments_stated: noul(
      "The transcript states which specific castaways ended up on which tribe. Announcing that a draw is happening, without naming who went where, does not count."
    ),
  };
  for (const t of SEASON_TRIBES) {
    q[`tribe_exists_${t.toLowerCase()}`] = noul(
      `A tribe called ${t} exists in this excerpt.`
    );
  }
  return q;
}

function challengeQuestions() {
  const q = {
    is_challenge: noul(
      "This excerpt is a challenge being run at the challenge area. Tribal council, camp conversation, and confessionals are not challenges."
    ),
    immunity_at_stake: noul("Immunity is awarded to someone in this challenge."),
    reward_at_stake: noul("A reward is awarded to someone in this challenge."),
    is_tribe_challenge: noul(
      "Castaways compete as tribes or teams in this challenge, rather than as individuals."
    ),
    only_two_teams: noul(
      "Exactly two tribes or teams competed in this challenge."
    ),
    three_or_more_teams: noul(
      "Three or more tribes or teams competed in this challenge."
    ),
  };
  for (const t of SEASON_TRIBES) {
    const k = t.toLowerCase();
    q[`first_${k}`] = noul(
      `${t} finished in first place in this challenge. Competing well, leading partway through, or nearly winning does not count.`
    );
    q[`second_${k}`] = noul(
      `${t} finished in second place in this challenge. Finishing first does not count. Finishing last does not count.`
    );
  }
  return q;
}

function tribalQuestions(cast) {
  const max = Math.max(cast.length, 1);
  const voteCriteria = { "0": "no votes were read with their name on them" };
  for (let i = 1; i <= max; i++)
    voteCriteria[String(i)] = `${i} vote${i === 1 ? "" : "s"} were read with their name on them`;

  const q = {
    is_tribal: noul(
      "This excerpt is a tribal council, where the host questions the castaways and votes are read aloud."
    ),
    votes_were_read: noul("The host read votes aloud at this tribal council."),
    vote_decided_exit: noul(
      "The castaway who left at this tribal council was decided by the votes read aloud, rather than by a fire-making challenge, a rock draw, or any other tiebreaker."
    ),
    fire_challenge_occurred: noul(
      "A fire-making challenge was held at this tribal council."
    ),
    revote_occurred: noul(
      "The first vote ended in a tie and the castaways voted a second time at this tribal council."
    ),
    any_advantage_played: noul(
      "At least one castaway played an idol or advantage at this tribal council. A shot in the dark does not count."
    ),
    any_shot_in_the_dark_played: noul(
      "At least one castaway played their shot in the dark at this tribal council."
    ),
  };

  for (const name of cast) {
    const k = name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    q[`attended_${k}`] = noul(
      `${name} was present at this tribal council. Being mentioned or talked about by someone who is present does not count.`
    );
    q[`votes_${k}`] = {
      type: "choice",
      instructions:
        `How many votes with ${name}'s name on them did the host read aloud at this tribal council? ` +
        `Count every vote read aloud, including any that were voided by an idol, advantage, or shot in the dark. ` +
        `A running tally restating votes already read is not additional votes. ` +
        `If there was a revote, count only the votes from the revote.`,
      criteria: voteCriteria,
    };
    q[`safe_${k}`] = noul(
      `${name} was safe from being voted out at this tribal council. This includes winning individual immunity before tribal council, and gaining safety during tribal council by playing an idol, an advantage, or a successful shot in the dark.`
    );
    q[`torch_${k}`] = noul(
      `The host told ${name} to bring their torch, or snuffed ${name}'s torch, at this tribal council.`
    );
    q[`advantage_played_by_${k}`] = noul(
      `${name} played an idol or advantage at this tribal council. A shot in the dark does not count. Talking about an advantage, or holding one without playing it, does not count.`
    );
    q[`advantage_played_on_${k}`] = noul(
      `An idol or advantage was played on ${name}'s behalf at this tribal council, making votes against ${name} not count. A shot in the dark does not count.`
    );
    q[`shot_in_the_dark_played_${k}`] = noul(
      `${name} played their shot in the dark at this tribal council. Mentioning or considering the shot in the dark without playing it does not count.`
    );
  }
  return q;
}

function templatesFor(id) {
  if (id === "tribeUpdate")
    return [
      {
        "on_{tribe}_{name}": {
          type: "noul",
          instructions:
            "{Name} is on the {Tribe} tribe after this assignment. Being considered for a tribe, or being mentioned, does not count.",
        },
      },
    ];
  if (id === "tribal")
    return [
      {
        "pair_{player}_{target}": {
          type: "noul",
          instructions:
            "{Player} played an idol or advantage on {Target}'s behalf at this tribal council. Playing it on their own behalf counts when {Player} and {Target} are the same person.",
        },
      },
    ];
  return [];
}

const BUILDERS = {
  journey: journeyQuestions,
  tribeUpdate: tribeUpdateQuestions,
  challenge: challengeQuestions,
  tribal: () => tribalQuestions(CAST),
};

const raw = loadCues(IN);
const cues = dropScrollRepeats(raw);
console.log(`loaded ${raw.length} cues, ${cues.length} after scroll-repeat removal`);
console.log(`span ${cues[0]?.start?.toFixed(0)}s - ${cues.at(-1)?.end?.toFixed(0)}s\n`);

if (args.includes("--audit")) {
  console.log("Every anchor match in the file, by segment type:\n");
  for (const def of SEGMENTS) {
    console.log(`### ${def.id}`);
    for (const kind of ["start", "require", "end"]) {
      if (!def[kind]) continue;
      for (const c of cues) {
        const hit = def[kind].find((r) => r.test(c.text));
        if (hit)
          console.log(
            `  ${kind.toUpperCase().padEnd(7)} [${c.start.toFixed(0)}s] /${hit.source}/ :: ${c.text.slice(0, 70)}`
          );
      }
    }
    console.log("");
  }
  process.exit(0);
}

const segments = findSegments(cues);
if (!segments.length) {
  console.log("no segments matched. anchors need work -- try --lead/--tail or inspect the cues.");
  process.exit(0);
}

function nextReplayDir(baseDir = ".") {
  const existing = readdirSync(baseDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => /^replay-(\d+)$/.exec(d.name))
    .filter(Boolean)
    .map((m) => parseInt(m[1], 10));

  const next = existing.length ? Math.max(...existing) + 1 : 1;
  const dir = join(baseDir, `replay-${next}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const replayDir = nextReplayDir();

segments.forEach((seg, n) => {
  const sel = withBuffer(cues, seg);
  const state = assembleState(sel);
  const questions = BUILDERS[seg.def.id]();
  const templates = templatesFor(seg.def.id);

  const file = join(replayDir, `${EPISODE}p${n + 1}.jsonl`);
  const lines = [
    JSON.stringify({ host: HOST, transcript: state }),
    JSON.stringify(questions),
    ...templates.map((t) => JSON.stringify(t)),
  ];
  writeFileSync(file, lines.join("\n") + "\n");

  console.log(
    `p${n + 1}  ${seg.def.id.padEnd(12)} ${seg.def.event.padEnd(12)} ` +
    `${seg.startTime.toFixed(0)}-${seg.endTime.toFixed(0)}s  ` +
    `${sel.length} cues, ${state.length} chars, ` +
    `${Object.keys(questions).length} questions` +
    (templates.length ? `, ${templates.length} template(s)` : "") +
    (seg.incomplete ? "  [INCOMPLETE - no result found in window]" : "")
  );
  console.log(`     trigger: ${seg.trigger}`);
  {
    const line = (c) => (c ? `[${c.start.toFixed(0)}s] ${c.text.slice(0, 70)}` : "(none)");
    console.log(`     START   /${seg.startPat?.source}/  ${line(cues[seg.startIdx])}`);
    console.log(`     REQUIRE ${seg.requirePat ? "/" + seg.requirePat.source + "/  " + line(seg.requireCue) : (seg.def.require ? "NOT MET" : "n/a")}`);
    console.log(`     CLOSED  by ${seg.closedBy}${seg.endPat ? "  /" + seg.endPat.source + "/" : ""}`);
    console.log(`     LASTLINE ${line(seg.endCue)}`);
  }
  console.log(`     -> ${file}`);
})
