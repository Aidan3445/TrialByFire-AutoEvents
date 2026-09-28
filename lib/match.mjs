/**
 * Near-miss phrase matching for anchors.
 *
 * Text and phrases are compared with case, spaces and punctuation stripped,
 * so "This isa hidden immunity idol" and "I'm Survivorrich" match cleanly.
 * Phrases of MIN_FUZZY letters or more also tolerate dropped or garbled
 * letters, down to SIMILARITY; shorter ones must appear exactly, since one
 * edit in "done it" already matches "I've done it".
 *
 * `exact` lists skip the near-miss step. Use it for anchors that confirm a
 * segment rather than trigger one: a near miss there ("win immunity" in
 * "once again, immunity") confirms a false segment and cannot be cancelled.
 */

const SIMILARITY = 0.8;
const MIN_FUZZY = 10;

export const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function phrases(list, { exact = false } = {}) {
  return list.map((text) => {
    const n = normalize(text);
    const k = exact || n.length < MIN_FUZZY ? 0 : Math.floor(n.length * (1 - SIMILARITY) + 1e-9);
    return { text, n, k };
  });
}

/**
 * Edits needed for the best occurrence of p anywhere inside t (Sellers),
 * or more than k if there is none within k. Ukkonen's cutoff only extends
 * rows that can still finish within k, so long cues stay cheap.
 */
function distance(p, t, k) {
  const m = p.length;
  const d = new Int32Array(m + 1);
  for (let i = 0; i <= m; i++) d[i] = i;
  let active = Math.min(k, m);
  let best = k + 1;
  for (let j = 0; j < t.length; j++) {
    const c = t.charCodeAt(j);
    const top = Math.min(m, active + 1);
    let diag = 0;
    for (let i = 1; i <= top; i++) {
      const up = d[i];
      d[i] = Math.min(up + 1, d[i - 1] + 1, diag + (p.charCodeAt(i - 1) === c ? 0 : 1));
      diag = up;
    }
    active = top;
    while (active > 0 && d[active] > k) d[active--] = k + 1;
    if (active === m && d[m] < best && (best = d[m]) === 0) break;
  }
  return best;
}

/** Highest-scoring phrase found in normalized text, or null. */
export function bestMatch(list, text) {
  let hit = null;
  for (const p of list) {
    let score = 0;
    if (text.includes(p.n)) score = 1;
    else if (p.k > 0 && text.length >= p.n.length - p.k) {
      const d = distance(p.n, text, p.k);
      if (d <= p.k) score = 1 - d / p.n.length;
    }
    if (score > (hit?.score ?? 0)) {
      hit = { phrase: p.text, score: Math.round(score * 100) / 100 };
      if (score === 1) break;
    }
  }
  return hit;
}
