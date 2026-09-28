/**
 * Derivation: Jev's answers for one segment -> draft events for the app.
 *
 * Every answer is read as yes / unsure / no. Per-castaway questions also get
 * a noise floor from the canaries asked the same question: `safe_` canaries
 * score ~0.55 while `torch_` canaries score ~0.03, so a fixed cut-off alone
 * would let `safe_` noise through. Anything unsure becomes an `unresolved`
 * field with suggestions, so the card asks instead of guessing.
 */

import { keyOf } from "./keys.ts";
import { questionSetVersion } from "./prompt.ts";
import type {
  Answers,
  BaseEventName,
  Check,
  ChoiceResult,
  Context,
  Derivation,
  DraftEvent,
  Labels,
  People,
  Questions,
  Reader,
  Scored,
  SegmentDef,
  Template,
  Unresolved,
  Verdict,
} from "./types/index.ts";

export const THRESHOLDS = {
  yes: 0.7,
  no: 0.3,
  /** Include in follow-up question sets (pairing). */
  followup: 0.5,
  /** How far a castaway must clear the canaries on the same question. */
  margin: 0.1,
};

const verdict = (p: number, floor = 0): Verdict =>
  p >= THRESHOLDS.yes && p >= floor + THRESHOLDS.margin ? "yes" : p <= THRESHOLDS.no ? "no" : "unsure";

export function createReader(answers: Answers, ctx: Context, labels: Labels = {}): Reader {
  const p = (key: string) => {
    const a = answers[key];
    return a?.type === "noul" ? a.noul : null;
  };
  const labelMap = (key: string) =>
    labels[key] ?? Object.entries(labels).find(([k]) => k.endsWith("*") && key.startsWith(k.slice(0, -1)))?.[1];

  return {
    p,
    is(key) {
      const x = p(key);
      return x == null ? null : verdict(x);
    },
    yes(key) {
      const x = p(key);
      return x != null && verdict(x) === "yes";
    },
    choice(key): ChoiceResult | null {
      const a = answers[key];
      return a?.type === "choice" ? { value: a.choice, confidence: a.confidence, probabilities: a.probabilities } : null;
    },
    label: (key, value) => labelMap(key)?.[value] ?? null,
    people(prefix, names = ctx.cast): People {
      const floor = Math.max(0, ...ctx.canaries.map((c) => p(prefix + keyOf(c)) ?? 0));
      const scored = names
        .map((name) => ({ name, p: p(prefix + keyOf(name)) }))
        .filter((s): s is Scored => s.p != null)
        .sort((a, b) => b.p - a.p);
      const yes = scored.filter((s) => verdict(s.p, floor) === "yes");
      const unsure = scored.filter(
        (s) => !yes.includes(s) && s.p > THRESHOLDS.no && s.p >= floor + THRESHOLDS.margin
      );
      return { yes, unsure, plausible: [...yes, ...unsure], floor };
    },
    keys: (pattern) => Object.keys(answers).filter((k) => pattern.test(k)),
  };
}

// ---------------------------------------------------------------------------
// Building blocks for segment derive() functions

/** The segment's scene question: proceed on yes or unsure, flag unsure. */
export function gate(r: Reader, key: string): { detected: number | null; open: boolean; doubt: Unresolved[] } {
  const p = r.p(key);
  const v = r.is(key);
  return {
    detected: p,
    open: v === "yes" || v === "unsure",
    doubt: v === "unsure" ? [{ field: "event", reason: `not sure this happened (${key} ${p})` }] : [],
  };
}

export function draft(
  eventName: BaseEventName,
  o: {
    label?: string | null;
    labelConfidence?: number;
    confidence?: number | null;
    people?: Scored[];
    tribes?: string[];
    notes?: string[];
    unresolved?: Unresolved[];
  } = {}
): DraftEvent {
  const confidence: Record<string, number> = {};
  if (o.confidence != null) confidence.event = o.confidence;
  if (o.labelConfidence != null) confidence.label = o.labelConfidence;
  for (const s of o.people ?? []) confidence[`ref:${s.name}`] = s.p;
  return {
    eventName,
    label: o.label ?? null,
    references: [
      ...(o.tribes ?? []).map((name) => ({ type: "Tribe" as const, name })),
      ...(o.people ?? []).map((s) => ({ type: "Castaway" as const, name: s.name })),
    ],
    notes: o.notes ?? [],
    confidence,
    unresolved: o.unresolved ?? [],
  };
}

/** A who-question the card should ask, offering everyone above the noise floor. */
export const pick = (field: string, people: People, reason: string): Unresolved => ({
  field,
  reason,
  options: people.plausible.map((s) => ({ value: s.name, confidence: s.p })),
});

/** App label for a choice answer, flagged when Jev was not confident. */
export function choiceLabel(r: Reader, key: string): { label: string | null; confidence: number; unresolved: Unresolved[] } {
  const c = r.choice(key);
  if (!c) return { label: null, confidence: 0, unresolved: [{ field: "label", reason: `${key} not answered` }] };
  const label = r.label(key, c.value);
  if (c.confidence >= THRESHOLDS.yes) return { label, confidence: c.confidence, unresolved: [] };
  const options = Object.entries(c.probabilities)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([value, confidence]) => ({ value: r.label(key, value) ?? value, confidence }));
  return { label, confidence: c.confidence, unresolved: [{ field: "label", reason: `${key} unsure`, options }] };
}

export const names = (list: Scored[]) => list.map((s) => s.name).join(", ");

export const check = (name: string, ok: boolean, detail: string, soft = false): Check => ({
  name,
  status: ok ? "pass" : soft ? "warn" : "fail",
  detail,
});

/** Fill a template once per combination of values, e.g. { castaway: [...], target: [...] }. */
export function fillTemplate(template: Template, sets: Record<string, string[]>): Questions {
  let combos: Record<string, string>[] = [{}];
  for (const [placeholder, values] of Object.entries(sets))
    combos = combos.flatMap((c) => values.map((v) => ({ ...c, [placeholder]: v })));
  const out: Questions = {};
  for (const combo of combos)
    for (const [key, q] of Object.entries(template)) {
      let k = key;
      let text = q.instructions;
      for (const [placeholder, v] of Object.entries(combo)) {
        k = k.replaceAll(`{${placeholder}}`, keyOf(v));
        text = text.replaceAll(`{${placeholder}}`, v);
      }
      out[k] = { ...q, instructions: text };
    }
  return out;
}

/** People worth pairing in a follow-up. */
export const followupCandidates = (people: People) =>
  people.plausible.filter((s) => s.p >= THRESHOLDS.followup).map((s) => s.name);

// ---------------------------------------------------------------------------

function canaryChecks(answers: Answers, ctx: Context): Check[] {
  const lit: string[] = [];
  let max = 0;
  for (const canary of ctx.canaries) {
    const suffix = `_${keyOf(canary)}`;
    for (const [key, a] of Object.entries(answers)) {
      if (a.type !== "noul" || !key.endsWith(suffix)) continue;
      max = Math.max(max, a.noul);
      if (a.noul >= THRESHOLDS.yes) lit.push(`${key} ${a.noul}`);
    }
  }
  return ctx.canaries.length
    ? [check("canaries", !lit.length, lit.length ? `canary lit up: ${lit.join(", ")}` : `quiet (max ${max})`)]
    : [];
}

export function deriveSegment(def: SegmentDef, ctx: Context, answers: Answers): Derivation {
  const r = createReader(answers, ctx, def.labels);
  const out = def.derive?.(r, ctx) ?? { detected: null, events: [] };
  const pending = Object.entries(out.followups ?? {}).filter(([k]) => !(k in answers));
  return {
    segment: def.id,
    questionSetVersion: questionSetVersion(def),
    detected: out.detected,
    events: out.events,
    checks: [...(out.checks ?? []), ...canaryChecks(answers, ctx)],
    followups: pending.length ? Object.fromEntries(pending) : null,
  };
}

/** Checks across all segments of one episode. */
export function checkEpisode(results: Derivation[]): Check[] {
  const events = results.flatMap((d) => d.events);
  const refs = (name: BaseEventName) =>
    new Set(events.filter((e) => e.eventName === name).flatMap((e) => e.references.map((x) => x.name)));
  const immune = refs("indivWin");
  const eliminated = refs("elim");
  const clash = [...immune].filter((n) => eliminated.has(n));
  const winners = [...refs("soleSurvivor")];
  return [
    check("immunity winner not voted out", !clash.length, clash.length ? `both: ${clash.join(", ")}` : "ok"),
    check("at most one Sole Survivor", winners.length <= 1, winners.join(", ") || "none"),
  ];
}
