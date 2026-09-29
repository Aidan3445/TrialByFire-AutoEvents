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

function fromJsonl(lines: string[]): Cue[] {
  const out: Cue[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let o: JsonlRecord;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const text = clean(String(o.text ?? o.caption ?? o.content ?? ""));
    if (!text) continue;
    out.push({
      key: o.key ?? String(out.length),
      text,
      start: Number(o.start ?? o.starttime ?? o.startTime ?? out.length),
      end: Number(o.end ?? o.endtime ?? o.endTime ?? out.length + 1),
      boundary: o.boundary ?? null,
      seq: o.seq ?? out.length,
    });
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
