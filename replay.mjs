/**
 * Episode replay harness.
 *
 * Scans a captured transcript for segment anchors and writes one prompt file
 * per detected segment, plus a meta sidecar for diagnostics and provenance.
 *
 *   node replay.mjs cues/s51e1.jsonl
 *   node replay.mjs imported-transcripts/s44e12.txt --context contexts/s44e12.json
 *
 * Input: cue-server JSONL, or plain text with one cue per line (timing is
 * synthesised from word count).
 *
 * Output per segment, in replay-N/:
 *   {ep}p{n}.jsonl       line 1 state, line 2 questions, line 3+ pairing templates
 *   {ep}p{n}.meta.json   events, question set version, anchors, gaps, gates
 */

import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { join, basename, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { suspectScore } from "./cue-server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const IN = args[0];
const argOf = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

if (!IN || IN.startsWith("--")) {
  console.error("usage: node replay.mjs <cues.jsonl|transcript.txt> [options]");
  console.error("  --episode NAME   output file prefix (default: input file name)");
  console.error("  --context FILE   season context JSON (default: contexts/{episode}.json)");
  console.error("  --lead    N      seconds to include before start anchor (default: 20)");
  console.error("  --tail    N      seconds to include after end anchor (default: 20)");
  console.error("  --audit          print every anchor match by segment type, then exit");
  process.exit(2);
}

const EPISODE = argOf("--episode", basename(IN).replace(/\.(jsonl|txt)$/, ""));
const LEAD_S = Number(argOf("--lead", "20"));
const TAIL_S = Number(argOf("--tail", "20"));

// These are only needed for the imported transcripts
const WORDS_PER_SECOND = 2.5;
const GAP_S = 20;
const MERGE_GAP_S = 180;
const RECAP_SEARCH_S = 600;
const RECAP_MAX_S = 300;
const RECAP_FALLBACK_S = 180;

// In the app system, context will be provided by the server, here we have local files
function loadContext() {
  const explicit = argOf("--context", null);
  const path = explicit ?? join(HERE, "contexts", `${EPISODE}.json`);
  const base = { host: "Jeff Probst", cast: [], eliminated: [], tribes: [], canaries: [], title: null };
  if (!existsSync(path)) {
    if (explicit) {
      console.error(`context file not found: ${path}`);
      process.exit(2);
    }
    console.log(`no context at ${path} -- per-castaway and per-tribe questions omitted\n`);
    return base;
  }
  return { ...base, ...JSON.parse(readFileSync(path, "utf8")) };
}

const ctx = loadContext();

function fromJsonl(lines) {
  const out = [];
  for (const line of lines) {
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
      seq: o.seq ?? out.length,
    });
  }
  return out;
}

function fromText(lines) {
  const out = [];
  let t = 0;
  for (const line of lines) {
    const text = line.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const dur = Math.max(1, text.split(" ").length / WORDS_PER_SECOND);
    out.push({
      key: `l_${out.length}`,
      text,
      start: t,
      end: t + dur,
      boundary: /^(-|>>)|^[A-Z][A-Z .']+:/.test(text) ? "speaker" : null,
      seq: out.length,
      synthetic: true,
    });
    t += dur;
  }
  return out;
}

function loadCues(path) {
  const lines = readFileSync(path, "utf8").split("\n");
  const cues = path.endsWith(".txt") ? fromText(lines) : fromJsonl(lines);
  return cues
    .filter((c) => suspectScore(c.synthetic ? { text: c.text } : c).score < 0.5)
    .sort((a, b) => a.start - b.start || a.seq - b.seq);
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

// Don't create events from the recap
function stripRecap(cues) {
  if (!cues.length) return { cues, recap: null };
  const t0 = cues[0].start;
  const i = cues.findIndex(
    (c) => c.start - t0 <= RECAP_SEARCH_S && /previously on survivor/i.test(c.text)
  );
  if (i < 0) return { cues, recap: null };
  const from = cues[i].start;
  let j = cues.findIndex(
    (c, k) => k >= i && c.start - from <= RECAP_MAX_S && /the tribe has spoken/i.test(c.text)
  );
  const closedBy = j >= 0 ? "the tribe has spoken" : `fallback ${RECAP_FALLBACK_S}s`;
  if (j < 0) j = cues.findLastIndex((c) => c.start - from <= RECAP_FALLBACK_S);
  return {
    cues: [...cues.slice(0, i), ...cues.slice(j + 1)],
    recap: { from, to: cues[j].end, cues: j - i + 1, closedBy },
  };
}

const noul = (instructions) => ({ type: "noul", instructions });
const choice = (instructions, criteria) => ({ type: "choice", instructions, criteria });
const keyOf = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Mix in the canaries for testing the system against non-existing castaways
const withCanaries = (names) => [...new Set([...names, ...ctx.canaries])].sort();

function qset() {
  const questions = {};
  const gates = {};
  return {
    questions,
    gates,
    add(key, spec, gate) {
      questions[key] = spec;
      if (gate) gates[key] = gate;
    },
  };
}

const ADVANTAGES = {
  idol: ["Idol", "a hidden immunity idol"],
  extra_vote: ["Extra Vote", "an extra vote at tribal council"],
  steal_a_vote: ["Steal a Vote", "the power to take another castaway's vote and cast it yourself"],
  block_a_vote: ["Block a Vote", "the power to take away another castaway's vote"],
  safety_without_power: ["Safety Without Power", "the power to leave tribal council safe, without voting"],
  idol_nullifier: ["Idol Nullifier", "the power to cancel an idol played by another castaway"],
  knowledge_is_power: ["Knowledge is Power", "the power to demand an advantage from another castaway"],
  challenge_advantage: ["Challenge Advantage", "an edge in an upcoming challenge"],
  beware_advantage: [
    "Beware Advantage",
    "an advantage that costs the holder something, such as their vote, until they complete a task",
  ],
  novel: ["Advantage", "an advantage that does not match any of the kinds listed"],
};
const TRIBAL_ADVANTAGES = [
  "idol", "extra_vote", "steal_a_vote", "block_a_vote", "safety_without_power",
  "idol_nullifier", "knowledge_is_power", "novel",
];
const advantageCriteria = (keys) =>
  Object.fromEntries(keys.map((k) => [k, ADVANTAGES[k][1]]));

export const LABELS = {
  advantage: Object.fromEntries(Object.entries(ADVANTAGES).map(([k, [label]]) => [k, label])),
  tribeUpdate: { starting_tribes: "Starting Tribes", swap: "Tribe Swap", new_tribes: "New Tribes", merge: "Merge Tribe" },
  exit: { med_evac: "Med Evacuation", quit: "Quit", removed: "Removed" },
  redemption: {
    redemption_island: "Redemption",
    edge_of_extinction: "Edge of Extinction",
    outcasts: "Outcasts",
    second_chance: "Second Chance",
  },
};

const COLOURS = ["blue", "red", "yellow", "green", "orange", "purple", "black", "white", "pink"];

function journeyQuestions(c) {
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
  for (const name of withCanaries(c.cast))
    q.add(`involves_${keyOf(name)}`, noul(
      `${name} is directly involved in this event. Being mentioned, or talking about it in an interview, does not count.`
    ), "notable_event");
  return q;
}

function tribeUpdateQuestions(c) {
  const q = qset();
  q.add("tribe_change_occurred", noul("Castaways were assigned to new tribes in this excerpt."));
  q.add("update_kind", choice("What kind of tribe change happened in this excerpt?", {
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
    for (const name of withCanaries(c.cast))
      q.add(`on_${keyOf(t)}_${keyOf(name)}`, noul(
        `${name} is on the ${t} tribe after this assignment. Being considered for a tribe, or being mentioned, does not count.`
      ), "assignments_stated");
  }
  return q;
}

function challengeQuestions(c, info) {
  const q = qset();
  q.add("is_challenge", noul(
    "This excerpt is a challenge being run at the challenge area. Tribal council, camp conversation, and confessionals are not challenges."
  ));
  q.add("immunity_at_stake", noul("Immunity is awarded to someone in this challenge."));
  q.add("reward_at_stake", noul("A reward is awarded to someone in this challenge."));
  q.add("multiple_winners", noul(
    "More than one castaway or team is awarded the same prize in this challenge."
  ));
  q.add("field_kind", choice("Do castaways compete as individuals or as teams in this challenge?", {
    individual: "each castaway competes for themselves",
    team: "castaways compete as members of a team or tribe",
  }));
  q.add("grouping", choice("How are the castaways grouped for this challenge?", {
    existing_tribes: "they compete in the tribes they already belong to",
    new_teams: "they are drawn, picked, or assigned into teams just for this challenge",
    none: "they are not divided into any groups",
  }));
  q.add("team_count", choice("How many tribes or teams compete against each other in this challenge?", {
    two: "exactly two tribes or teams",
    three_or_more: "three or more tribes or teams",
    no_teams: "castaways do not compete as tribes or teams",
  }));

  const placement = (label, k, gate) => {
    q.add(`first_${k}`, noul(
      `${label} finished in first place in this challenge. Competing well, leading partway through, or nearly winning does not count.`
    ), gate);
    q.add(`second_${k}`, noul(
      `${label} finished in second place in this challenge. Finishing first does not count. Finishing last does not count.`
    ), "team_count=three_or_more");
  };
  for (const t of c.tribes) placement(t, keyOf(t));

  const tribeKeys = new Set(c.tribes.map(keyOf));
  for (const colour of info.colours.filter((x) => !tribeKeys.has(keyOf(x)))) {
    const k = keyOf(colour);
    const Label = cap(colour);
    q.add(`team_exists_${k}`, noul(
      `A team called ${Label} competed in this challenge. A passing mention of the colour ${colour} that is not a team name does not count.`
    ));
    placement(Label, k, `team_exists_${k}`);
    for (const name of withCanaries(c.cast))
      q.add(`on_${k}_${keyOf(name)}`, noul(`${name} competed for ${Label} in this challenge.`),
        `team_exists_${k}&grouping=new_teams`);
  }

  for (const name of withCanaries(c.cast)) {
    const k = keyOf(name);
    q.add(`won_immunity_${k}`, noul(
      `${name} won individual immunity in this challenge. Competing well, leading, or nearly winning does not count. Immunity won in an earlier episode does not count. Being on a tribe or team that won does not count.`
    ));
    q.add(`won_reward_${k}`, noul(
      `${name} won the reward in this challenge as an individual. Competing well, leading, or nearly winning does not count. Being on a tribe or team that won, or being chosen to join the winner, does not count.`
    ));
    q.add(`brought_on_reward_${k}`, noul(
      `${name} was chosen by the reward winner to share the reward. The winner themselves does not count.`
    ), "won_reward_*&field_kind=individual");
  }
  return q;
}

function tribalQuestions(c) {
  const q = qset();
  q.add("is_tribal", noul(
    "This excerpt is a tribal council, where the host questions the castaways and votes are read aloud."
  ));
  q.add("votes_were_read", noul("The host read votes aloud at this tribal council."));
  q.add("revote_occurred", noul(
    "The first vote ended in a tie and the castaways voted a second time at this tribal council."
  ));
  q.add("any_advantage_played", noul(
    "At least one castaway played an idol or advantage at this tribal council. A shot in the dark does not count."
  ));
  q.add("any_shot_in_the_dark_played", noul(
    "At least one castaway played their shot in the dark at this tribal council."
  ));
  q.add("exit_method", choice("How was the castaway who left the game at this tribal council decided?", {
    votes: "by the votes read aloud, including a revote after a tie",
    rock_draw: "by drawing rocks after a deadlocked vote",
    fire_making: "by losing a fire-making challenge",
    other: "they left some other way, such as quitting or being removed from the game",
    none: "no castaway left the game at this tribal council",
  }));

  for (const name of withCanaries(c.cast)) {
    const k = keyOf(name);
    const at = `attended_${k}`;
    q.add(at, noul(
      `${name} was present at this tribal council. Being mentioned or talked about by someone who is present does not count.`
    ));
    q.add(`received_votes_${k}`, noul(
      `At least one vote with ${name}'s name on it was read aloud at this tribal council, including votes that did not count because of an idol, advantage, or shot in the dark. Being discussed as a possible target does not count.`
    ), at);
    q.add(`safe_${k}`, noul(
      `${name} was safe from being voted out at this tribal council. This includes winning individual immunity before tribal council, and gaining safety during tribal council by playing an idol, an advantage, or a successful shot in the dark.`
    ), at);
    q.add(`torch_${k}`, noul(
      `The host told ${name} to bring their torch, or snuffed ${name}'s torch, at this tribal council.`
    ), at);
    q.add(`advantage_played_by_${k}`, noul(
      `${name} played an idol or advantage at this tribal council. A shot in the dark does not count. Talking about an advantage, or holding one without playing it, does not count.`
    ), at);
    q.add(`advantage_played_on_${k}`, noul(
      `An idol or advantage was played on ${name}'s behalf at this tribal council, making votes against ${name} not count. A shot in the dark does not count.`
    ), at);
    q.add(`advantage_effective_${k}`, noul(
      `${name} played an idol or advantage at this tribal council that changed who went home: had it not been played, a different castaway would have left the game. If it cancelled the votes against a castaway who received the most votes, or tied for the most votes, it counts as changing the outcome. Playing an idol or advantage that made no difference to who went home does not count. A shot in the dark does not count.`
    ), `advantage_played_by_${k}`);
    q.add(`advantage_kind_${k}`, choice(
      `What kind of idol or advantage did ${name} play at this tribal council?`,
      advantageCriteria(TRIBAL_ADVANTAGES)
    ), `advantage_played_by_${k}`);
    q.add(`shot_in_the_dark_played_${k}`, noul(
      `${name} played their shot in the dark at this tribal council. Mentioning or considering the shot in the dark without playing it does not count.`
    ), at);
  }
  return q;
}

function fireQuestions(c) {
  const q = qset();
  q.add("fire_challenge_occurred", noul(
    "A fire-making challenge was held in this excerpt. Practising fire at camp, or talking about fire-making, does not count."
  ));
  for (const name of withCanaries(c.cast)) {
    const k = keyOf(name);
    q.add(`fire_competed_${k}`, noul(`${name} competed in the fire-making challenge.`), "fire_challenge_occurred");
    q.add(`fire_win_${k}`, noul(
      `${name} won the fire-making challenge. Competing in it or nearly winning does not count.`
    ), "fire_challenge_occurred");
  }
  return q;
}

function scrollQuestions(c) {
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
    ...advantageCriteria(Object.keys(ADVANTAGES)),
    shot_in_the_dark: "a shot in the dark",
    clue_only: "only a clue or directions toward an advantage, not the advantage itself",
  }), "is_scroll_reading");
  for (const name of withCanaries(c.cast))
    q.add(`holder_${keyOf(name)}`, noul(
      `${name} is the castaway who found or earned this advantage in this excerpt. Being told about it, or having found it in an earlier episode, does not count.`
    ), "is_scroll_reading");
  return q;
}

function handoffQuestions(c) {
  const q = qset();
  q.add("advantage_handed_off", noul(
    "One castaway gives an idol or advantage to another castaway to keep in this excerpt. Playing an idol on someone's behalf at tribal council does not count. Offering it without handing it over does not count."
  ));
  for (const name of withCanaries(c.cast)) {
    const k = keyOf(name);
    q.add(`gave_${k}`, noul(`${name} gave an idol or advantage to another castaway.`), "advantage_handed_off");
    q.add(`received_${k}`, noul(`${name} received an idol or advantage from another castaway.`), "advantage_handed_off");
  }
  return q;
}

function exitQuestions(c) {
  const q = qset();
  q.add("exit_occurred", noul(
    "A castaway left the game in this excerpt for a reason other than being voted out — a medical evacuation, quitting, or being removed. Being examined by medical and continuing to play does not count. Talking about quitting without leaving does not count."
  ));
  q.add("exit_kind", choice("Why did the castaway leave the game?", {
    med_evac: "they were removed for medical reasons",
    quit: "they chose to quit",
    removed: "production removed them for their conduct",
  }), "exit_occurred");
  for (const name of withCanaries(c.cast))
    q.add(`left_game_${keyOf(name)}`, noul(
      `${name} is the castaway who left the game in this excerpt without being voted out.`
    ), "exit_occurred");
  return q;
}

function redemptionQuestions(c) {
  const q = qset();
  q.add("returned_to_game", noul(
    "A castaway who had been eliminated re-entered the game in this excerpt. Being given a chance to return but failing does not count."
  ));
  q.add("redemption_kind", choice("How did the eliminated castaway get back into the game?", {
    redemption_island: "by winning a duel at Redemption Island",
    edge_of_extinction: "by winning a return challenge from the Edge of Extinction",
    outcasts: "by competing as a tribe of voted-out castaways against the remaining tribes",
    second_chance: "by some other twist that brings an eliminated castaway back",
  }), "returned_to_game");
  for (const name of withCanaries(c.eliminated))
    q.add(`returned_${keyOf(name)}`, noul(
      `${name} is the eliminated castaway who re-entered the game.`
    ), "returned_to_game");
  return q;
}

function finaleQuestions(c) {
  const q = qset();
  q.add("is_winner_reveal", noul("The host reveals the winner of the season in this excerpt."));
  for (const name of withCanaries(c.cast))
    q.add(`winner_${keyOf(name)}`, noul(
      `${name} was named the Sole Survivor and won the season. Receiving jury votes without being named the winner does not count.`
    ), "is_winner_reveal");
  return q;
}

function titleQuestions(c) {
  const q = qset();
  const title = c.title ?? "{TITLE}";
  q.add("title_spoken", noul(
    `A line in this transcript is the source of the episode title "${title}". The line may be a close paraphrase rather than an exact match.`
  ));
  for (const name of withCanaries(c.cast))
    q.add(`title_speaker_${keyOf(name)}`, noul(
      `${name} spoke the line that the episode title "${title}" is drawn from.`
    ), "title_spoken");
  return q;
}

const PAIR_TEMPLATE = {
  "pair_{player}_{target}": noul(
    "{Player} played an idol or advantage on {Target}'s behalf at this tribal council. Playing it on their own behalf counts when {Player} and {Target} are the same person."
  ),
};
const HANDOFF_TEMPLATE = {
  "gave_{giver}_to_{receiver}": noul("{Giver} gave an idol or advantage to {Receiver}."),
};

const rx = (arr) => arr.map((s) => new RegExp(s, "i"));

const RULES_TALK = [
  "\\b(first|last) (tribe|team|person|one|two|three|castaway|to)\\b",
  "\\bwhoever\\b",
  "\\b(will|to|going to|trying to|want to|hope to) win\\b",
  "\\bwinners? (will|get|gets|receive|take|takes)\\b",
  "\\bthe winner (will|gets|of this)\\b",
  "\\bwins? (immunity|reward)\\?",
];

const SEGMENTS = [
  {
    id: "journey",
    events: ["otherNotes"],
    start: rx([
      "(go|going|sent|send|gone) on a journey",
      "on a journey for",
      "choose (one|a|someone|somebody)\\b.*\\b(person|castaway|go|represent)",
      "(welcome to|sent to|go to|going to) (survivor )?exile",
      "one of you will not",
      "open the (next )?envelope",
      "read (the|this) sign",
      "\\bsummit\\b",
      "risk (it|your vote)",
    ]),
    end: rx(["grab your stuff", "head (out|back)", "good luck", "back to camp"]),
    maxSpan: 240,
    build: journeyQuestions,
  },
  {
    id: "tribeUpdate",
    events: ["tribeUpdate"],
    start: rx([
      "drop your buffs",
      "draw(ing)? for (your )?(new )?tribes",
      "new tribes",
      "tribe swap",
      "come get your buff",
      "new (tribe )?buffs?",
      "you('re| are) (now )?merged",
      "(you|we)('re| are) (all )?one tribe",
      "welcome to the merge",
    ]),
    end: rx(["grab your stuff", "head out", "your new home", "head (back )?to (your )?(new )?camp"]),
    maxSpan: 240,
    build: tribeUpdateQuestions,
  },
  {
    id: "challenge",
    events: ["indivWin", "indivReward", "tribe1st", "tribe2nd"],
    start: rx([
      "come on in",
      "immunity is back up for grabs",
      "once again,? immunity",
      "want to know what you'?re playing for",
      "for today'?s challenge",
      "today'?s (reward|immunity) challenge",
      "shall we get to (your|the|today'?s)",
      "survivors ready",
      "draw for (spots|teams|partners)",
      "schoolyard pick",
    ]),
    require: rx([
      "wins? (individual )?(immunity|reward|it)",
      "(immunity|reward) is yours",
      "you'?re all safe",
      "winner",
      "that'?s it, it'?s over",
    ]),
    requireNot: rx(RULES_TALK),
    end: rx([
      "grab your stuff",
      "head back to camp",
      "head out",
      "got nothing for you",
      "nothing for you",
      "see you at tribal",
    ]),
    maxSpan: 600,
    mergeIncomplete: true,
    build: challengeQuestions,
  },
  {
    id: "tribal",
    events: ["elim", "advPlay", "badAdvPlay"],
    start: rx([
      "i'?ll go tally",
      "once the votes are read",
      "time to vote",
      "let'?s get to the vote",
      "back at camp",
      "what are you feeling",
      "bring in the members",
    ]),
    startNot: rx(["waiting for you back at camp"]),
    require: rx([
      "i'?ll go tally",
      "(i'?ll|let'?s) read the votes",
      "first vote",
      "that'?s one vote",
      "once the votes are read",
    ]),
    end: rx(["the tribe has spoken", "grab your torch", "bring me your torch"]),
    maxSpan: 900,
    build: tribalQuestions,
    templates: [PAIR_TEMPLATE],
  },
  {
    id: "fire",
    events: ["fireWin", "noVoteExit"],
    start: rx([
      "fire[- ]making challenge",
      "(have|going|gonna) to make fire (to|for)",
      "burn through (that|the) rope",
    ]),
    require: rx([
      "\\bdone it\\b",
      "earned (the|a|her|his|their) (final|third) spot",
      "wins? fire",
      "won fire",
      "(burned|burnt) through",
    ]),
    requireNot: rx(RULES_TALK),
    end: rx(["the tribe has spoken", "bring me your torch", "snuff"]),
    maxSpan: 900,
    build: fireQuestions,
  },
  {
    id: "scroll",
    events: ["advFound", "otherNotes"],
    start: rx([
      "congratulations,? you('ve| have) found",
      "you('ve| have) found (a|an|the) (hidden immunity idol|idol|advantage)",
      "this is an? (hidden immunity idol|idol|advantage|beware)",
      "\\bbeware\\b",
      "if you choose to (accept|use|play|take)",
      "this (advantage|idol) (expires|is good|is valid|can be used)",
      "(good|valid) (through|until) (the )?final",
      "read the (note|scroll|parchment)",
      "what does it say",
    ]),
    startNot: rx(["if anybody has", "now would be the time"]),
    maxSpan: 90,
    build: scrollQuestions,
  },
  {
    id: "handoff",
    events: ["otherNotes"],
    start: rx([
      "(give|gave|giving|hand|handed|handing|pass|passed|passing) (you|him|her|them)? ?(my|the|this|our|her|his) (hidden immunity )?(idol|advantage|shot in the dark)",
      "(give|gave|giving|hand|handed|handing) (it|this|that) to (you|him|her|them)",
      "(idol|advantage) (is )?(yours|for you)\\b",
    ]),
    maxSpan: 120,
    build: handoffQuestions,
    templates: [HANDOFF_TEMPLATE],
  },
  {
    id: "exit",
    events: ["noVoteExit"],
    start: rx([
      "\\bmedical\\b",
      "(have|going|need) to pull you",
      "pull(ed)? (you )?(from|out of) the game",
      "your game is over",
      "evacuat",
      "can'?t continue",
      "(want|going|decided) to quit",
      "\\bi quit\\b",
      "quit the game",
      "removed from the game",
      "(leave|leaving) the game",
    ]),
    startNot: rx(["voted out", "(leave|leaving) (the game|tribal council) immediately"]),
    maxSpan: 300,
    build: exitQuestions,
  },
  {
    id: "redemption",
    events: ["redemption"],
    start: rx([
      "edge of extinction",
      "redemption island",
      "\\bthe outcasts\\b",
      "(back|return(ing)?|re-?enter(ing)?) (in|into|to) (the|this) game",
      "second chance",
      "earn (your|their|a) way back",
      "rejoin(ing)? the game",
    ]),
    maxSpan: 300,
    build: redemptionQuestions,
  },
  {
    id: "finale",
    events: ["soleSurvivor"],
    start: rx(["winner of survivor", "jury'?s? votes?", "the votes (are in|have been cast)"]),
    require: rx(["winner of survivor", "sole survivor", "you('re| are) the winner"]),
    maxSpan: 600,
    build: finaleQuestions,
  },
];

const EPISODE_SCANS = [
  { id: "title", events: ["spokeEpTitle"], needs: "title", build: titleQuestions },
];

const firstHit = (pats, text, not) => {
  if (!pats) return null;
  const hit = pats.find((r) => r.test(text));
  if (!hit || (not && not.some((r) => r.test(text)))) return null;
  return hit;
};

function scan(def, cues) {
  const found = [];
  let i = 0;
  while (i < cues.length) {
    const startPat = firstHit(def.start, cues[i].text, def.startNot);
    if (!startPat) {
      i++;
      continue;
    }
    const startCue = cues[i];
    let satisfied = !def.require;
    let requirePat = null;
    let requireCue = null;
    let endPat = null;
    let endIdx = null;
    let hitCap = false;
    for (let j = i; j < cues.length; j++) {
      if (cues[j].start - startCue.start > def.maxSpan) {
        hitCap = true;
        break;
      }
      if (!satisfied) {
        const hit = firstHit(def.require, cues[j].text, def.requireNot);
        if (hit) {
          satisfied = true;
          requirePat = hit;
          requireCue = cues[j];
        }
        continue;
      }
      if (j === i) continue;
      const hit = def.end ? firstHit(def.end, cues[j].text) : null;
      if (hit) {
        endIdx = j;
        endPat = hit;
        break;
      }
    }
    if (endIdx == null) {
      endIdx = cues.findLastIndex((c) => c.start - startCue.start <= def.maxSpan);
      if (endIdx <= i) endIdx = Math.min(i + 40, cues.length - 1);
    }
    found.push({
      def,
      startIdx: i,
      endIdx,
      incomplete: !satisfied,
      startPat,
      requirePat,
      requireCue,
      endPat,
      closedBy: endPat ? "end anchor" : hitCap ? "span cap" : "end of transcript",
      startTime: startCue.start,
      endTime: cues[endIdx].end,
      trigger: startCue.text.slice(0, 60),
      mergedFrom: 1,
    });
    i = endIdx + 1;
  }
  return def.mergeIncomplete ? mergeIncomplete(found) : found;
}

function mergeIncomplete(found) {
  const out = [];
  for (const f of found) {
    const prev = out.at(-1);
    if (
      prev &&
      prev.incomplete &&
      prev.closedBy === "span cap" &&
      f.startTime - prev.endTime <= MERGE_GAP_S
    ) {
      out[out.length - 1] = {
        ...f,
        startIdx: prev.startIdx,
        startTime: prev.startTime,
        startPat: prev.startPat,
        trigger: prev.trigger,
        mergedFrom: prev.mergedFrom + f.mergedFrom,
      };
    } else out.push(f);
  }
  return out;
}

function withBuffer(cues, seg) {
  const lead = seg.startTime - LEAD_S;
  const tail = seg.endTime + TAIL_S;
  const sel = cues.filter((c) => c.start >= lead && c.start <= tail);
  return sel.length ? sel : cues.slice(seg.startIdx, seg.endIdx + 1);
}

function gapsIn(sel) {
  const gaps = [];
  for (let i = 0; i + 1 < sel.length; i++) {
    const d = sel[i + 1].start - sel[i].end;
    if (d > GAP_S) gaps.push({ at: Math.round(sel[i].end), seconds: Math.round(d) });
  }
  return gaps;
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

const coloursIn = (text) => COLOURS.filter((c) => new RegExp(`\\b${c}\\b`, "i").test(text));

function questionSetVersion(def) {
  const placeholder = {
    host: ctx.host,
    cast: ["{Name}"],
    eliminated: ["{Name}"],
    tribes: ["{Tribe}"],
    canaries: [],
    title: "{TITLE}",
  };
  const { questions } = def.build(placeholder, { colours: ["{label}"] });
  const body = JSON.stringify({ questions, templates: def.templates ?? [] });
  return `${def.id}-${createHash("sha256").update(body).digest("hex").slice(0, 8)}`;
}



const loaded = loadCues(IN);
const deduped = dropScrollRepeats(loaded);
const { cues, recap } = stripRecap(deduped);
console.log(`loaded ${loaded.length} cues, ${deduped.length} after scroll-repeat removal`);
if (recap)
  console.log(
    `recap stripped: ${recap.cues} cues, ${recap.from.toFixed(0)}-${recap.to.toFixed(0)}s (closed by ${recap.closedBy})`
  );
console.log(`span ${cues[0]?.start?.toFixed(0)}s - ${cues.at(-1)?.end?.toFixed(0)}s\n`);

if (args.includes("--audit")) {
  console.log("Every anchor match in the file, by segment type. x = excluded.\n");
  for (const def of SEGMENTS) {
    console.log(`### ${def.id}`);
    for (const [kind, not] of [["start", "startNot"], ["require", "requireNot"], ["end", null]]) {
      if (!def[kind]) continue;
      for (const c of cues) {
        const hit = def[kind].find((r) => r.test(c.text));
        if (!hit) continue;
        const excluded = not && def[not]?.some((r) => r.test(c.text));
        console.log(
          `  ${(kind.toUpperCase() + (excluded ? " x" : "")).padEnd(9)} [${c.start.toFixed(0)}s] /${hit.source}/ :: ${c.text.slice(0, 70)}`
        );
      }
    }
    console.log("");
  }
  process.exit(0);
}

const segments = SEGMENTS.flatMap((def) => scan(def, cues)).sort((a, b) => a.startTime - b.startTime);

function nextReplayDir(baseDir = ".") {
  const existing = readdirSync(baseDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => /^replay-(\d+)$/.exec(d.name))
    .filter(Boolean)
    .map((m) => parseInt(m[1], 10));
  const dir = join(baseDir, `replay-${existing.length ? Math.max(...existing) + 1 : 1}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const replayDir = nextReplayDir();
const versions = new Map([...SEGMENTS, ...EPISODE_SCANS].map((d) => [d.id, questionSetVersion(d)]));
const line = (c) => (c ? `[${c.start.toFixed(0)}s] ${c.text.slice(0, 70)}` : "(none)");

function write(n, def, sel, state, meta) {
  const { questions, gates } = def.build(ctx, { colours: coloursIn(state) });
  const templates = def.templates ?? [];
  const file = join(replayDir, `${EPISODE}p${n}.jsonl`);
  writeFileSync(
    file,
    [
      JSON.stringify({ host: ctx.host, transcript: state }),
      JSON.stringify(questions),
      ...templates.map((t) => JSON.stringify(t)),
    ].join("\n") + "\n"
  );
  writeFileSync(
    join(replayDir, `${EPISODE}p${n}.meta.json`),
    JSON.stringify(
      {
        episode: EPISODE,
        segment: def.id,
        events: def.events,
        questionSetVersion: versions.get(def.id),
        ...meta,
        window: { start: sel[0]?.start, end: sel.at(-1)?.end, cues: sel.length, chars: state.length },
        firstKey: sel[0]?.key,
        lastKey: sel.at(-1)?.key,
        canaries: ctx.canaries,
        gates,
      },
      null,
      2
    ) + "\n"
  );
  return { file, count: Object.keys(questions).length, templates: templates.length };
}

let n = 0;
for (const seg of segments) {
  n++;
  const sel = withBuffer(cues, seg);
  const state = assembleState(sel);
  const gaps = gapsIn(sel);
  const out = write(n, seg.def, sel, state, {
    incomplete: seg.incomplete,
    mergedFrom: seg.mergedFrom,
    anchors: {
      start: { pattern: seg.startPat?.source, time: seg.startTime, text: cues[seg.startIdx].text },
      require: seg.requirePat
        ? { pattern: seg.requirePat.source, time: seg.requireCue.start, text: seg.requireCue.text }
        : seg.def.require
          ? "not met"
          : null,
      closedBy: seg.closedBy,
      end: seg.endPat?.source ?? null,
      lastLine: cues[seg.endIdx].text,
    },
    gaps,
  });

  console.log(
    `p${n}  ${seg.def.id.padEnd(12)} ${seg.def.events.join(",").padEnd(30)} ` +
    `${seg.startTime.toFixed(0)}-${seg.endTime.toFixed(0)}s  ` +
    `${sel.length} cues, ${state.length} chars, ${out.count} questions` +
    (out.templates ? `, ${out.templates} template(s)` : "") +
    (seg.incomplete ? "  [INCOMPLETE - no result found in window]" : "")
  );
  console.log(`     START   /${seg.startPat?.source}/  ${line(cues[seg.startIdx])}`);
  console.log(
    `     REQUIRE ${seg.requirePat ? "/" + seg.requirePat.source + "/  " + line(seg.requireCue) : seg.def.require ? "NOT MET" : "n/a"}`
  );
  console.log(`     CLOSED  by ${seg.closedBy}${seg.endPat ? "  /" + seg.endPat.source + "/" : ""}`);
  console.log(`     LASTLINE ${line(cues[seg.endIdx])}`);
  if (seg.mergedFrom > 1) console.log(`     MERGED  ${seg.mergedFrom} segments`);
  if (gaps.length)
    console.log(`     GAPS    ${gaps.map((g) => `${g.seconds}s at ${g.at}s`).join(", ")}`);
  console.log(`     -> ${out.file}`);
}

for (const scanDef of EPISODE_SCANS) {
  if (!ctx[scanDef.needs]) {
    console.log(`\n${scanDef.id}: skipped, no ${scanDef.needs} in context`);
    continue;
  }
  n++;
  const state = assembleState(cues);
  const out = write(n, scanDef, cues, state, { scope: "episode" });
  console.log(
    `\np${n}  ${scanDef.id.padEnd(12)} ${scanDef.events.join(",").padEnd(30)} whole episode, ` +
    `${cues.length} cues, ${state.length} chars, ${out.count} questions\n     -> ${out.file}`
  );
}

if (!segments.length) console.log("no segments matched. anchors need work -- try --audit.");
