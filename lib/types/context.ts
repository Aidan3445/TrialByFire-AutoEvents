/**
 * Identity tables the transcript assumes but never states. In the app these
 * come from the server; the replay harness reads them from contexts/*.json.
 */
export interface Context {
  host: string;
  /** Castaways still in the game at the start of the episode. */
  cast: string[];
  eliminated: string[];
  /** Current tribe names; empty after the merge. */
  tribes: string[];
  /** Known-absent names mixed into per-castaway questions to catch drift. */
  canaries: string[];
  title: string | null;
}
