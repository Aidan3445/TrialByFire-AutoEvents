export interface Phrase {
  text: string;
  /** Normalized: lowercase letters and digits only. */
  n: string;
  /** Edits allowed for a near miss; 0 means exact. */
  k: number;
}

export interface Match {
  phrase: string;
  /** 1 for an exact match, down to the near-miss threshold. */
  score: number;
}
