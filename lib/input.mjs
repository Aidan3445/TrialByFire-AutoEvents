/**
 * File readers for offline replay. Live capture gets cues from cueServer
 * instead, already in the JSONL cue shape.
 */

import { readFileSync } from "fs";

// Measured on s51e1 speech; only used to synthesise timing for .txt input
const WORDS_PER_SECOND = 2.5;

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

/** cueServer JSONL, or plain text with one cue per line, in airing order. */
export function readCueFile(path) {
  const lines = readFileSync(path, "utf8").split("\n");
  const cues = path.endsWith(".txt") ? fromText(lines) : fromJsonl(lines);
  return cues.sort((a, b) => a.start - b.start || a.seq - b.seq);
}
