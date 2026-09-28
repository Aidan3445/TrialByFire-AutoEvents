/** `>>` in the caption marks a speaker change, `>>>` a topic change. */
export type Boundary = "speaker" | "topic" | null;

export interface Cue {
  key: string;
  text: string;
  /** Seconds from the start of the stream. */
  start: number;
  end: number;
  boundary: Boundary;
  /** Arrival order; breaks ties between the two lines of a caption. */
  seq: number;
  /** Timing estimated from word count (imported .txt transcripts). */
  synthetic?: boolean;
}

/** A cue as the browser tap posts it and cueServer persists it. */
export interface StoredCue extends Partial<Omit<Cue, "key" | "text">> {
  key: string;
  text: string;
  media_time?: number;
  wall_time?: number;
  href?: string;
  received_at?: string;
  suspect?: boolean;
  suspect_score?: number;
  suspect_reasons?: string[];
  duplicate?: boolean;
}

export interface SuspectScore {
  score: number;
  reasons: string[];
}

export interface RecapInfo {
  from: number;
  to: number;
  cues: number;
  closedBy: string;
}

export interface CleanerStats {
  /** Cues that passed the garbage filter. */
  loaded: number;
  /** Of those, cues left after scroll-repeat removal. */
  deduped: number;
  recap: RecapInfo | null;
  preview: { from: number } | null;
}
