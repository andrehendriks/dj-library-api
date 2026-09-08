import type { Track } from "@prisma/client";
import { z } from "zod";

import { toTrackResponse } from "./track-service.js";

export const autoDjQuerySchema = z.object({
  bpm: z.coerce.number().finite().min(1).max(400).optional(),
  key: z.string().trim().min(1).max(32).optional(),
  genre: z.string().trim().min(1).max(255).optional(),
  minDurationSeconds: z.coerce.number().int().positive().optional(),
  maxDurationSeconds: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(200).default(25)
}).refine(
  (value) => value.minDurationSeconds === undefined ||
    value.maxDurationSeconds === undefined ||
    value.minDurationSeconds <= value.maxDurationSeconds,
  { message: "minDurationSeconds must be less than or equal to maxDurationSeconds", path: ["minDurationSeconds"] }
);

export type AutoDjQuery = z.infer<typeof autoDjQuerySchema>;

function normalized(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

export function selectAutoDjTracks(tracks: Track[], query: AutoDjQuery): Track[] {
  return tracks
    .filter((track) =>
      (query.minDurationSeconds === undefined || (track.durationSeconds ?? 0) >= query.minDurationSeconds) &&
      (query.maxDurationSeconds === undefined || (track.durationSeconds ?? Number.MAX_SAFE_INTEGER) <= query.maxDurationSeconds)
    )
    .map((track, index) => ({
      track,
      index,
      score:
        (query.bpm === undefined || track.bpm === null ? 100 : Math.abs(track.bpm - query.bpm)) +
        (query.key === undefined || normalized(track.key) === normalized(query.key) ? 0 : 40) +
        (query.genre === undefined || normalized(track.genre) === normalized(query.genre) ? 0 : 20)
    }))
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .slice(0, query.limit)
    .map(({ track }) => track);
}

export function isSafeMusicPath(filePath: string | null, prefix = "/music/"): filePath is string {
  return filePath !== null &&
    prefix.startsWith("/") &&
    prefix.endsWith("/") &&
    filePath.startsWith(prefix) &&
    !filePath.includes("\\") &&
    !filePath.includes("\0") &&
    filePath.split("/").every((part) => part !== "..");
}

export function toM3u8(tracks: Track[], prefix = "/music/"): string {
  const entries = tracks
    .filter((track) => isSafeMusicPath(track.filePath, prefix))
    .map((track) => `#EXTINF:${track.durationSeconds ?? -1},${track.artist} - ${track.title}\n${track.filePath}`);
  return `#EXTM3U\n${entries.length > 0 ? `${entries.join("\n")}\n` : ""}`;
}

export function toMixxxPath(filePath: string | null, containerPrefix: string, mixxxPrefix: string): string | null {
  if (!isSafeMusicPath(filePath, containerPrefix)) return null;
  const normalizedPrefix = mixxxPrefix.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalizedPrefix || normalizedPrefix.includes("\0") || normalizedPrefix.split("/").some((part) => part === "..")) return null;
  return `${normalizedPrefix}/${filePath.slice(containerPrefix.length)}`;
}

export function toMixxxM3u8(tracks: Track[], containerPrefix = "/music/", mixxxPrefix = "//stream-vught-nl/Dj/Music/"): string {
  const entries = tracks
    .map((track) => {
      const mixxxPath = toMixxxPath(track.filePath, containerPrefix, mixxxPrefix);
      return mixxxPath ? `#EXTINF:${track.durationSeconds ?? -1},${track.artist} - ${track.title}\n${mixxxPath}` : null;
    })
    .filter((entry): entry is string => entry !== null);
  return `#EXTM3U\n${entries.length > 0 ? `${entries.join("\n")}\n` : ""}`;
}

export function toAutoDjResponse(tracks: Track[]) {
  return { data: tracks.map(toTrackResponse), count: tracks.length };
}
