import type { Context } from "./types/index.ts";

export const DEFAULT_CONTEXT: Context = {
  host: "Jeff Probst",
  cast: [],
  eliminated: [],
  tribes: [],
  canaries: [],
  title: null,
};

export const withDefaults = (ctx: Partial<Context> = {}): Context => ({ ...DEFAULT_CONTEXT, ...ctx });
