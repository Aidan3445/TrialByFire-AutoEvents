/**
 * Scores draft events against the app's recorded events.
 *
 * Events are compared as (eventName, reference) pairs, counted as multisets
 * (episode 1 has two Nami tribe1st events). A miss is "assisted" when the
 * right answer was offered on the card as an unresolved suggestion, so one
 * tap would fix it.
 */

import type { BaseEventName, DraftEvent, TruthEvent } from "./types/index.ts";

/** Derived from app state (roster, prior advFound), never from a transcript. */
export const NOT_SCANNED: BaseEventName[] = ["finalists", "advElim"];
/** The league does not record these, so they are counted but not scored. */
export const UNSCORED: BaseEventName[] = ["otherNotes"];

export interface Predicted extends DraftEvent {
  prompt: string;
}

export interface Row {
  eventName: string;
  truth: number;
  predicted: number;
  hits: number;
  misses: number;
  falseAlarms: number;
  assisted: number;
  /** Draft cards with no confident reference: neither hit nor false alarm, but still a card. */
  empty: number;
}

export interface EpisodeScore {
  episode: number;
  rows: Row[];
  misses: { eventName: string; name: string; assisted: boolean }[];
  falseAlarms: { eventName: string; name: string; prompts: string[] }[];
}

type Family = (name: string) => string;
export const strict: Family = (n) => n;
/** The league scores every exit the same; the truth files fire-making losses as elim. */
export const exitsTogether: Family = (n) => (n === "elim" || n === "noVoteExit" ? "exit" : n);

const pair = (eventName: string, name: string) => `${eventName}|${name}`;
const split = (key: string) => {
  const i = key.indexOf("|");
  return { eventName: key.slice(0, i), name: key.slice(i + 1) };
};

function count(keys: string[]) {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}

export function scoreEpisode(episode: number, truth: TruthEvent[], predicted: Predicted[], family: Family = strict): EpisodeScore {
  const skip = new Set<string>([...NOT_SCANNED, ...UNSCORED]);
  const t = count(
    truth.filter((e) => !skip.has(e.eventName)).flatMap((e) => e.references.map((r) => pair(family(e.eventName), r)))
  );
  const scored = predicted.filter((e) => !skip.has(e.eventName));
  const p = count(scored.flatMap((e) => e.references.map((r) => pair(family(e.eventName), r.name))));
  const promptsFor = new Map<string, string[]>();
  for (const e of scored)
    for (const r of e.references) {
      const k = pair(family(e.eventName), r.name);
      promptsFor.set(k, [...(promptsFor.get(k) ?? []), e.prompt]);
    }

  // Suggestions on the card: alternative references, or an alternative event name
  const suggested = new Set<string>();
  for (const e of scored) {
    const names = e.unresolved
      .filter((u) => u.field === "references")
      .flatMap((u) => u.options?.map((o) => o.value) ?? []);
    const eventNames = e.unresolved
      .filter((u) => u.field === "eventName")
      .flatMap((u) => u.options?.map((o) => o.value) ?? []);
    for (const n of names) suggested.add(pair(family(e.eventName), n));
    for (const en of eventNames) for (const r of e.references) suggested.add(pair(family(en), r.name));
  }

  const rows = new Map<string, Row>();
  const row = (eventName: string) => {
    if (!rows.has(eventName))
      rows.set(eventName, { eventName, truth: 0, predicted: 0, hits: 0, misses: 0, falseAlarms: 0, assisted: 0, empty: 0 });
    return rows.get(eventName)!;
  };
  const misses: EpisodeScore["misses"] = [];
  const falseAlarms: EpisodeScore["falseAlarms"] = [];
  for (const key of new Set([...t.keys(), ...p.keys()])) {
    const { eventName, name } = split(key);
    const tc = t.get(key) ?? 0;
    const pc = p.get(key) ?? 0;
    const r = row(eventName);
    r.truth += tc;
    r.predicted += pc;
    r.hits += Math.min(tc, pc);
    for (let i = pc; i < tc; i++) {
      const assisted = suggested.has(key);
      r.misses++;
      if (assisted) r.assisted++;
      misses.push({ eventName, name, assisted });
    }
    if (pc > tc) {
      r.falseAlarms += pc - tc;
      falseAlarms.push({ eventName, name, prompts: promptsFor.get(key) ?? [] });
    }
  }
  for (const e of scored) if (!e.references.length) row(family(e.eventName)).empty++;
  return { episode, rows: [...rows.values()].sort((a, b) => a.eventName.localeCompare(b.eventName)), misses, falseAlarms };
}

export function totals(scores: EpisodeScore[]): Row[] {
  const out = new Map<string, Row>();
  for (const s of scores)
    for (const r of s.rows) {
      const o = out.get(r.eventName) ?? { ...r, truth: 0, predicted: 0, hits: 0, misses: 0, falseAlarms: 0, assisted: 0, empty: 0 };
      o.truth += r.truth;
      o.predicted += r.predicted;
      o.hits += r.hits;
      o.misses += r.misses;
      o.falseAlarms += r.falseAlarms;
      o.assisted += r.assisted;
      o.empty += r.empty;
      out.set(r.eventName, o);
    }
  return [...out.values()].sort((a, b) => a.eventName.localeCompare(b.eventName));
}

/**
 * Event level: was a card of this type drafted in the episode at all,
 * whoever it names? Catching the trigger is what matters most; the admin
 * fills in members. Extra cards of a type (duplicates, false triggers)
 * count as false alarms.
 */
export function scoreTriggers(episode: number, truth: TruthEvent[], predicted: Predicted[], family: Family = strict): EpisodeScore {
  const skip = new Set<string>([...NOT_SCANNED, ...UNSCORED]);
  const t = count(truth.filter((e) => !skip.has(e.eventName)).map((e) => family(e.eventName)));
  const scored = predicted.filter((e) => !skip.has(e.eventName));
  const p = count(scored.map((e) => family(e.eventName)));
  const rows: Row[] = [];
  const misses: EpisodeScore["misses"] = [];
  const falseAlarms: EpisodeScore["falseAlarms"] = [];
  for (const eventName of [...new Set([...t.keys(), ...p.keys()])].sort()) {
    const tc = t.get(eventName) ?? 0;
    const pc = p.get(eventName) ?? 0;
    const hits = Math.min(tc, pc);
    rows.push({ eventName, truth: tc, predicted: pc, hits, misses: tc - hits, falseAlarms: pc - hits, assisted: 0, empty: 0 });
    for (let i = hits; i < tc; i++) misses.push({ eventName, name: "", assisted: false });
    if (pc > tc)
      falseAlarms.push({
        eventName,
        name: `${pc - tc} extra`,
        prompts: scored.filter((e) => family(e.eventName) === eventName).map((e) => e.prompt),
      });
  }
  return { episode, rows, misses, falseAlarms };
}
