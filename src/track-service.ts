import type { Prisma, PrismaClient, Track } from "@prisma/client";

import type { TrackResponse } from "./types.js";

export function toTrackResponse(track: Track): TrackResponse {
  let tags: string[];
  try {
    const parsed: unknown = JSON.parse(track.tags);
    tags = Array.isArray(parsed) && parsed.every((tag) => typeof tag === "string") ? parsed : [];
  } catch {
    tags = [];
  }

  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    genre: track.genre,
    bpm: track.bpm,
    key: track.key,
    durationSeconds: track.durationSeconds,
    rating: track.rating,
    tags,
    filePath: track.filePath,
    createdAt: track.createdAt.toISOString(),
    updatedAt: track.updatedAt.toISOString()
  };
}

export function trackData(input: Record<string, unknown>): Prisma.TrackCreateInput {
  const { tags, ...rest } = input;
  return { ...rest, ...(tags !== undefined ? { tags: JSON.stringify(tags) } : {}) } as Prisma.TrackCreateInput;
}

export function trackUpdateData(input: Record<string, unknown>): Prisma.TrackUpdateInput {
  const { tags, ...rest } = input;
  return { ...rest, ...(tags !== undefined ? { tags: JSON.stringify(tags) } : {}) } as Prisma.TrackUpdateInput;
}

export async function findTrackOrThrow(prisma: PrismaClient, id: string): Promise<Track> {
  const track = await prisma.track.findUnique({ where: { id } });
  if (!track) {
    const error = new Error("Track not found");
    error.name = "NotFoundError";
    throw error;
  }
  return track;
}
