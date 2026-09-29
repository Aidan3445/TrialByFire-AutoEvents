/**
 * Season eval files: per-episode question context and ground truth from the
 * app's seasonData.
 */

import { readFileSync } from "fs";
import { withDefaults } from "./context.ts";
import type { AppCastaway, Context, SeasonData, SeasonFile, TruthEvent } from "./types/index.ts";

export interface Season {
  name: string;
  data: SeasonData;
  episodes: number[];
  contextFor(episode: number): Context;
  truthFor(episode: number): TruthEvent[];
}

export function loadSeason(path: string): Season {
  const file: SeasonFile = JSON.parse(readFileSync(path, "utf8"));
  const data = file.seasonsData[0];
  // The host is stored as a castaway so he can be credited with the title
  const players = data.castaways.filter((c) => c.fullName !== file.host);
  const castawayName = new Map(data.castaways.map((c) => [c.castawayId, c.shortName]));
  const tribeName = new Map(data.tribes.map((t) => [t.tribeId, t.tribeName]));
  const timeline = Object.keys(data.tribesTimeline).map(Number).sort((a, b) => a - b);
  const tribesAt = (ep: number) => Object.keys(data.tribesTimeline[String(ep)]).map((id) => tribeName.get(Number(id)) ?? id);
  const stillIn = (c: AppCastaway, ep: number) => c.eliminatedEpisode == null || c.eliminatedEpisode >= ep;

  function contextFor(ep: number): Context {
    // Tribes going into the episode plus any it creates (a swap or the merge)
    const before = timeline.filter((e) => e < ep).at(-1);
    const tribes = new Set([...(before ? tribesAt(before) : []), ...(timeline.includes(ep) ? tribesAt(ep) : [])]);
    return withDefaults({
      host: file.host,
      cast: players.filter((c) => stillIn(c, ep)).map((c) => c.shortName).sort(),
      eliminated: players.filter((c) => !stillIn(c, ep)).map((c) => c.shortName).sort(),
      tribes: [...tribes],
      canaries: file.canaries,
      title: file.titles.find((t) => t.num === ep)?.title ?? null,
    });
  }

  function truthFor(ep: number): TruthEvent[] {
    return Object.values(data.baseEvents[String(ep)] ?? {}).map((e) => ({
      eventId: e.eventId,
      eventName: e.eventName,
      label: e.label,
      references: e.references.map((r) =>
        (r.type === "Castaway" ? castawayName.get(r.id) : tribeName.get(r.id)) ?? `${r.type}#${r.id}`
      ),
    }));
  }

  const episodes = Object.keys(data.baseEvents).map(Number).sort((a, b) => a - b);
  return { name: data.season.name, data, episodes, contextFor, truthFor };
}
