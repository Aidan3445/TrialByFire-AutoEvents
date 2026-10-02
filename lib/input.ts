/**
 * File readers for offline replay. Live capture gets cues from cueServer
 * instead, already in the JSONL cue shape.
 */

import { readFileSync } from "fs";
import type { Cue, StoredCue } from "./types/index.ts";

// Measured on s51e1 speech; only used to synthesise timing for .txt input
const WORDS_PER_SECOND = 2.5;

// Zero-width characters are invisible but not whitespace, so a line of only
// them would otherwise survive as an empty-looking cue
const clean = (s: string) => s.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").replace(/\s+/g, " ").trim();

// Other capture tools name the fields differently
type JsonlRecord = Partial<StoredCue> & {
  caption?: string;
  content?: string;
  starttime?: number;
  startTime?: number;
  endtime?: number;
  endTime?: number;
};

/** One JSONL line -> cue, or null if it is blank, malformed, or has no text. `seq` is its arrival order. */
export function parseCueLine(line: string, seq: number): Cue | null {
  if (!line.trim()) return null;
  let o: JsonlRecord;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  const text = clean(String(o.text ?? o.caption ?? o.content ?? ""));
  if (!text) return null;
  return {
    key: o.key ?? String(seq),
    text,
    start: Number(o.start ?? o.starttime ?? o.startTime ?? seq),
    end: Number(o.end ?? o.endtime ?? o.endTime ?? seq + 1),
    boundary: o.boundary ?? null,
    seq: o.seq ?? seq,
  };
}

function fromJsonl(lines: string[]): Cue[] {
  const out: Cue[] = [];
  for (const line of lines) {
    const cue = parseCueLine(line, out.length);
    if (cue) out.push(cue);
  }
  return out;
}

function fromText(lines: string[]): Cue[] {
  const out: Cue[] = [];
  let t = 0;
  for (const line of lines) {
    const text = clean(line);
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

/** cueServer JSONL, or plain text with one cue per line, in airing order. */
export function readCueFile(path: string): Cue[] {
  const lines = readFileSync(path, "utf8").split("\n");
  const cues = path.endsWith(".txt") ? fromText(lines) : fromJsonl(lines);
  return cues.sort((a, b) => a.start - b.start || a.seq - b.seq);
}
