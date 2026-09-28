// Identity tables the transcript assumes but never states. In the app these
// come from the server; the replay harness reads them from contexts/*.json.
export const DEFAULT_CONTEXT = {
  host: "Jeff Probst",
  cast: [],
  eliminated: [],
  tribes: [],
  canaries: [],
  title: null,
};

export const withDefaults = (ctx = {}) => ({ ...DEFAULT_CONTEXT, ...ctx });
