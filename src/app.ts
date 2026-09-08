import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import fastifyStatic from "@fastify/static";
import { PrismaClient, type Prisma } from "@prisma/client";
import path from "node:path";
import { ZodError } from "zod";

import { autoDjQuerySchema, isSafeMusicPath, selectAutoDjTracks, toAutoDjResponse, toM3u8 } from "./autodj.js";
import { findDuplicateGroups, getMusicConfig, getScanStatus, scanMusic } from "./music-scanner.js";
import { getPlaylistConfig, getPlaylistImportStatus, importPlaylists } from "./playlist-importer.js";
import { trackCreateSchema, trackQuerySchema, trackUpdateSchema } from "./track-schema.js";
import { findTrackOrThrow, toTrackResponse, trackData, trackUpdateData } from "./track-service.js";

const trackProperties = {
  id: { type: "string" },
  title: { type: "string" },
  artist: { type: "string" },
  album: { type: ["string", "null"] },
  genre: { type: ["string", "null"] },
  bpm: { type: ["number", "null"] },
  key: { type: ["string", "null"] },
  durationSeconds: { type: ["integer", "null"] },
  rating: { type: ["integer", "null"] },
  tags: { type: "array", items: { type: "string" } },
  filePath: { type: ["string", "null"] },
  createdAt: { type: "string", format: "date-time" },
  updatedAt: { type: "string", format: "date-time" }
};

const flexibleQuerySchema = { type: "object", additionalProperties: true };

export async function buildApp(prisma = new PrismaClient()): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, _body, done) => {
    done(null, {});
  });
  const corsOrigins = (process.env.CORS_ORIGIN ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);
  await app.register(cors, {
    origin: corsOrigins.length > 0 ? corsOrigins : false
  });

  await app.register(swagger, {
    openapi: {
      info: { title: "DJ Library API", description: "Manage a DJ track library", version: "1.0.0" },
      servers: [{ url: "http://localhost:3000" }]
    }
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });
  await app.register(fastifyStatic, {
    root: path.resolve(process.cwd(), "static"),
    prefix: "/static/",
    decorateReply: false
  });
  app.get("/config.js", async (_request, reply) => {
    const apiBaseUrl = process.env.API_BASE_URL ?? "http://192.168.2.5:8080";
    return reply.type("application/javascript").send(`window.__DJ_LIBRARY_CONFIG__=${JSON.stringify({ API_BASE_URL: apiBaseUrl })};`);
  });
  await app.register(fastifyStatic, {
    root: path.resolve(process.cwd(), "static"),
    index: "index.html",
    decorateReply: false
  });

  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });

  app.get("/health", { schema: { tags: ["system"], response: { 200: { type: "object", properties: { status: { type: "string" } } } } } }, async () => ({ status: "ok" }));

  app.get("/api/v1/scan/status", { schema: { tags: ["scan"] } }, async (_request, reply) => {
    return reply.send({ ...getScanStatus(), musicRoot: getMusicConfig().root, musicPath: getMusicConfig().publicPath });
  });

  app.post("/api/v1/scan", { schema: { tags: ["scan"] } }, async (_request, reply) => {
    const scan = await scanMusic(prisma);
    return reply.code(scan.state === "failed" ? 500 : 200).send(scan);
  });

  app.get("/api/v1/duplicates", { schema: { tags: ["tracks"] } }, async (_request, reply) => {
    const groups = await findDuplicateGroups(prisma);
    return reply.send({
      data: groups.map((group) => ({
        signal: group.signal,
        match: group.match,
        tracks: group.tracks.map(toTrackResponse)
      })),
      count: groups.length
    });
  });

  app.get("/api/v1/playlists/import/status", { schema: { tags: ["playlists"] } }, async (_request, reply) => {
    return reply.send({ ...getPlaylistImportStatus(), ...getPlaylistConfig() });
  });

  app.post("/api/v1/playlists/import", { schema: { tags: ["playlists"] } }, async (_request, reply) => {
    const result = await importPlaylists(prisma);
    return reply.code(result.state === "failed" ? 500 : 200).send(result);
  });

  app.get("/api/v1/playlists", { schema: { tags: ["playlists"], querystring: { type: "object", properties: { category: { type: "string" }, page: { type: "integer", default: 1 }, pageSize: { type: "integer", default: 100 } } } } }, async (request, reply) => {
    const query = request.query as { category?: string; page?: number; pageSize?: number };
    const page = Math.max(1, Number(query.page ?? 1));
    const pageSize = Math.min(500, Math.max(1, Number(query.pageSize ?? 100)));
    const where = query.category ? { category: query.category } : {};
    const [data, total] = await Promise.all([
      prisma.playlistEntry.findMany({ where, orderBy: [{ category: "asc" }, { mixxxPath: "asc" }], skip: (page - 1) * pageSize, take: pageSize }),
      prisma.playlistEntry.count({ where })
    ]);
    return reply.send({ data, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
  });

  const autoDjHandler = async (request: { query: unknown }) => {
    const query = autoDjQuerySchema.parse(request.query);
    const tracks = await prisma.track.findMany({
      where: {
        ...(query.minDurationSeconds !== undefined || query.maxDurationSeconds !== undefined
          ? {
              durationSeconds: {
                ...(query.minDurationSeconds !== undefined ? { gte: query.minDurationSeconds } : {}),
                ...(query.maxDurationSeconds !== undefined ? { lte: query.maxDurationSeconds } : {})
              }
            }
          : {})
      },
      orderBy: { createdAt: "asc" }
    });
    return selectAutoDjTracks(tracks, query);
  };

  app.get("/api/v1/autodj/playlist", {
    schema: {
      tags: ["autodj"],
      querystring: flexibleQuerySchema
    }
  }, async (request, reply) => reply.send(toAutoDjResponse(await autoDjHandler(request))));

  app.get("/api/v1/autodj/playlist.m3u8", {
    schema: {
      tags: ["autodj"],
      querystring: flexibleQuerySchema
    }
  }, async (request, reply) => {
    const prefix = process.env.MUSIC_PATH_PREFIX ?? "/music/";
    const playlist = (await autoDjHandler(request)).filter((track) => isSafeMusicPath(track.filePath, prefix));
    return reply
      .type("audio/x-mpegurl")
      .header("Content-Disposition", 'attachment; filename="autodj.m3u8"')
      .send(toM3u8(playlist, prefix));
  });

  app.get("/api/v1/tracks", {
    schema: {
      tags: ["tracks"],
      querystring: flexibleQuerySchema,
      response: { 200: { type: "object" } }
    }
  }, async (request, reply) => {
    const query = trackQuerySchema.parse(request.query);
    const search = query.search ? [{ title: { contains: query.search } }, { artist: { contains: query.search } }, { album: { contains: query.search } }, { genre: { contains: query.search } }, { tags: { contains: query.search } }] : undefined;
    const where: Prisma.TrackWhereInput = {
      ...(search ? { OR: search } : {}),
      ...(query.genre ? { genre: { contains: query.genre } } : {}),
      ...(query.artist ? { artist: { contains: query.artist } } : {}),
      ...(query.minBpm !== undefined || query.maxBpm !== undefined ? { bpm: { ...(query.minBpm !== undefined ? { gte: query.minBpm } : {}), ...(query.maxBpm !== undefined ? { lte: query.maxBpm } : {}) } } : {}),
      ...(query.minRating !== undefined ? { rating: { gte: query.minRating } } : {})
    };
    const [tracks, total] = await Promise.all([
      prisma.track.findMany({ where, orderBy: { [query.sortBy]: query.sortOrder } as Prisma.TrackOrderByWithRelationInput, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      prisma.track.count({ where })
    ]);
    return reply.send({ data: tracks.map(toTrackResponse), pagination: { page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) } });
  });

  app.post("/api/v1/tracks", { schema: { tags: ["tracks"], body: { type: "object", required: ["title", "artist"], properties: trackProperties }, response: { 201: { type: "object", properties: trackProperties } } } }, async (request, reply) => {
    const body = trackCreateSchema.parse(request.body);
    const track = await prisma.track.create({ data: trackData(body) });
    return reply.code(201).send(toTrackResponse(track));
  });

  app.get("/api/v1/tracks/:id", { schema: { tags: ["tracks"], params: { type: "object", required: ["id"], properties: { id: { type: "string" } } } } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send(toTrackResponse(await findTrackOrThrow(prisma, id)));
  });

  app.get("/api/v1/tracks/:id/metadata", { schema: { tags: ["tracks"], params: { type: "object", required: ["id"], properties: { id: { type: "string" } } } } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const track = await findTrackOrThrow(prisma, id);
    return reply.send({
      id: track.id,
      metadataSource: track.metadataSource ?? "manual",
      fileHash: track.fileHash,
      title: track.title,
      artist: track.artist,
      album: track.album,
      genre: track.genre,
      bpm: track.bpm,
      key: track.key,
      durationSeconds: track.durationSeconds
    });
  });

  app.patch("/api/v1/tracks/:id", { schema: { tags: ["tracks"], params: { type: "object", required: ["id"], properties: { id: { type: "string" } } } } }, async (request, reply) => {
    const body = trackUpdateSchema.parse(request.body);
    const { id } = request.params as { id: string };
    await findTrackOrThrow(prisma, id);
    return reply.send(toTrackResponse(await prisma.track.update({ where: { id }, data: trackUpdateData(body) })));
  });

  app.delete("/api/v1/tracks/:id", { schema: { tags: ["tracks"], params: { type: "object", required: ["id"], properties: { id: { type: "string" } } } } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await findTrackOrThrow(prisma, id);
    await prisma.track.delete({ where: { id } });
    return reply.code(204).send();
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: error.issues } });
    if (error.name === "NotFoundError") return reply.code(404).send({ error: { code: "NOT_FOUND", message: error.message } });
    request.log.error(error);
    return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } });
  });

  return app;
}
