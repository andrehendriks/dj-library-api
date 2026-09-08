import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { buildApp } from "../src/app.js";
import { mapPlaylistPath, parsePlaylist } from "../src/playlist-importer.js";

const prisma = new PrismaClient();
const app = await buildApp(prisma);

beforeAll(async () => {
  await prisma.track.deleteMany();
});

beforeEach(async () => {
  await prisma.track.deleteMany();
});

afterAll(async () => {
  await app.close();
});

describe("tracks API", () => {
  it("parses Mixxx EXTINF path pairs and maps only the configured UNC root", () => {
    const config = { root: "/playlists", sourcePrefix: "//stream-vught-nl/Dj/Music/", mixxxPath: "/music/" };
    const entries = parsePlaylist(`#EXTM3U\n#EXTINF\n//stream-vught-nl/Dj/Music/Funk/Artist - Song.mp3\n#EXTINF:215,Artist - Tagged Song\n//stream-vught-nl/Dj/Music/Funk/Tagged.mp3\n//other-host/Dj/Music/Nope.mp3`, config);
    expect(entries).toHaveLength(2);
    expect(entries[1]?.artist).toBe("Artist");
    expect(entries[1]?.duration).toBe(215);
    expect(mapPlaylistPath("//stream-vught-nl/Dj/Music/../secret.mp3", config)).toBeNull();
    expect(mapPlaylistPath("//other-host/Dj/Music/nope.mp3", config)).toBeNull();
  });

  it("creates and retrieves a track", async () => {
    const created = await app.inject({ method: "POST", url: "/api/v1/tracks", payload: { title: "Test Track", artist: "Test Artist", bpm: 128, rating: 4, tags: ["house"] } });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.tags).toEqual(["house"]);

    const retrieved = await app.inject({ method: "GET", url: `/api/v1/tracks/${body.id}` });
    expect(retrieved.statusCode).toBe(200);
    expect(retrieved.json().title).toBe("Test Track");
  });

  it("filters, paginates, updates and deletes tracks", async () => {
    await app.inject({ method: "POST", url: "/api/v1/tracks", payload: { title: "House One", artist: "DJ A", genre: "House" } });
    await app.inject({ method: "POST", url: "/api/v1/tracks", payload: { title: "Techno One", artist: "DJ B", genre: "Techno" } });
    const listed = await app.inject({ method: "GET", url: "/api/v1/tracks?genre=House&page=1&pageSize=1" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().pagination.total).toBe(1);

    const created = await app.inject({ method: "POST", url: "/api/v1/tracks", payload: { title: "To Update", artist: "DJ C" } });
    const id = created.json().id;
    const updated = await app.inject({ method: "PATCH", url: `/api/v1/tracks/${id}`, payload: { rating: 5 } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().rating).toBe(5);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/tracks/${id}` })).statusCode).toBe(204);
  });

  it("returns consistent validation and not-found errors", async () => {
    const invalid = await app.inject({ method: "POST", url: "/api/v1/tracks", payload: { artist: "Missing title" } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("VALIDATION_ERROR");
    const missing = await app.inject({ method: "GET", url: "/api/v1/tracks/does-not-exist" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("NOT_FOUND");
  });

  it("generates deterministic AutoDJ JSON and safe M3U8 playlists", async () => {
    await app.inject({ method: "POST", url: "/api/v1/tracks", payload: { title: "Closest", artist: "DJ A", bpm: 124, genre: "House", key: "F# min", durationSeconds: 240, filePath: "/music/closest.mp3" } });
    await app.inject({ method: "POST", url: "/api/v1/tracks", payload: { title: "Unsafe", artist: "DJ B", bpm: 124, filePath: "../secret.mp3" } });
    const json = await app.inject({ method: "GET", url: "/api/v1/autodj/playlist?bpm=124&genre=House&limit=2" });
    expect(json.statusCode).toBe(200);
    expect(json.json().data[0].title).toBe("Closest");
    const m3u = await app.inject({ method: "GET", url: "/api/v1/autodj/playlist.m3u8?bpm=124&limit=2" });
    expect(m3u.statusCode).toBe(200);
    expect(m3u.body).toContain("/music/closest.mp3");
    expect(m3u.body).not.toContain("secret.mp3");
  });
});
