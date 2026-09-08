import { z } from "zod";

const optionalText = z.string().trim().min(1).nullable().optional();

export const trackCreateSchema = z.object({
  title: z.string().trim().min(1).max(255),
  artist: z.string().trim().min(1).max(255),
  album: optionalText,
  genre: optionalText,
  bpm: z.number().finite().min(1).max(400).nullable().optional(),
  key: optionalText,
  durationSeconds: z.number().int().positive().nullable().optional(),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(50).optional(),
  filePath: optionalText
}).strict();

export const trackUpdateSchema = trackCreateSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field must be provided"
);

export const trackQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
  genre: z.string().trim().min(1).optional(),
  artist: z.string().trim().min(1).optional(),
  minBpm: z.coerce.number().finite().min(1).max(400).optional(),
  maxBpm: z.coerce.number().finite().min(1).max(400).optional(),
  minRating: z.coerce.number().int().min(1).max(5).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
  sortBy: z.enum(["title", "artist", "album", "genre", "bpm", "rating", "createdAt", "updatedAt"]).default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc")
}).refine(
  (value) => value.minBpm === undefined || value.maxBpm === undefined || value.minBpm <= value.maxBpm,
  { message: "minBpm must be less than or equal to maxBpm", path: ["minBpm"] }
);
