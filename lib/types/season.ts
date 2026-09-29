import type { BaseEventName } from "./events.ts";

/** The app's seasonData, as exported into an eval context file (only the fields we read). */
export interface AppCastaway {
  castawayId: number;
  fullName: string;
  shortName: string;
  eliminatedEpisode: number | null;
}

export interface AppTribe {
  tribeId: number;
  tribeName: string;
}

export interface AppEvent {
  eventId: number;
  episodeNumber: number;
  eventName: BaseEventName;
  label: string;
  notes: string[];
  references: { type: "Castaway" | "Tribe"; id: number }[];
}

export interface SeasonData {
  season: { seasonId: number; name: string };
  castaways: AppCastaway[];
  tribes: AppTribe[];
  /** episode number -> eventId -> event */
  baseEvents: Record<string, Record<string, AppEvent>>;
  /** episode number -> tribeId -> castawayIds, for episodes where tribes changed */
  tribesTimeline: Record<string, Record<string, number[]>>;
}

/** imported/eval/<season>/context.json */
export interface SeasonFile {
  host: string;
  canaries: string[];
  titles: { num: number; title: string }[];
  seasonsData: SeasonData[];
}

/** A ground-truth event with ids resolved to the names used in questions. */
export interface TruthEvent {
  eventId: number;
  eventName: BaseEventName;
  label: string;
  references: string[];
}
