# DJ Library API

A type-safe REST API for managing a DJ track library, built with Fastify, TypeScript, Prisma and SQLite.

## Local setup

```bash
npm install
copy .env.example .env
npm run db:generate
npm run db:push
npm run db:seed
npm run dev
```

The API listens on `http://localhost:3000`. Interactive OpenAPI documentation is available at `http://localhost:3000/docs`.
The bundled frontend is available at `http://localhost:3000/` and uses relative API URLs plus a locally served Alpine.js build, so it works without an internet connection.
The container defaults to the Synology address `http://192.168.2.5:8080`: `config.js` is generated at runtime and sets the frontend API base URL. When the frontend is served by this API on the same origin, the frontend automatically uses relative `/api/v1/...` requests instead.

For the NAS deployment, copy `.env.example` to `.env` and adjust `API_BASE_URL`, `CORS_ORIGIN` and `HOST_PORT` if needed:

```bash
HOST_PORT=8080
API_BASE_URL=http://192.168.2.5:8080
CORS_ORIGIN=http://192.168.2.5:8080
docker compose up -d --build
```

If the frontend is opened from another hostname or port, set `CORS_ORIGIN` to a comma-separated allowlist of exact origins (for example `https://dj.example.test,http://192.168.2.5:8080`). Do not use `*` for a deployment that may later add credentials.

## AutoDJ

AutoDJ uses a stable, predictable score: BPM distance first, then exact key and genre matches, with creation order as the tie-breaker. It supports `bpm`, `key`, `genre`, `minDurationSeconds`, `maxDurationSeconds` and `limit`.

```bash
curl "http://localhost:3000/api/v1/autodj/playlist?bpm=124&key=F%23%20min&genre=House&limit=20"
curl -OJ "http://localhost:3000/api/v1/autodj/playlist.m3u8?bpm=124&genre=House&limit=20"
```

The JSON playlist uses container paths such as `/music/...`. The downloadable M3U8 uses `MIXXX_MUSIC_PATH` (default `//stream-vught-nl/Dj/Music/`) so Mixxx on the Windows host can resolve the files directly. Set it to the exact path Mixxx sees, for example `Z:/Music/` or `//nas/Dj/Music/`; the value is only a path prefix and traversal is rejected.

## Music scanning, metadata and duplicates

Scanning is deliberately restricted to the configured `MUSIC_ROOT`; the API never accepts a filesystem path from a request. `MUSIC_PATH` is the Mixxx/container path prefix written to imported `filePath` values. Only these recursive audio extensions are considered: `mp3`, `flac`, `wav`, `m4a`, `aac`, `ogg`, `oga`, `opus`, `aiff` and `alac`.

Metadata is read with `music-metadata`, a pure JavaScript package with no native CPU dependency, so the same image works on ARM64, Raspberry Pi and Armbian. Unsupported or damaged tags gracefully fall back to a filename-derived title, `Unknown artist`, file size duration estimate and `metadataSource: "fallback"`.

```bash
curl -X POST http://192.168.2.5:8080/api/v1/scan
curl http://192.168.2.5:8080/api/v1/scan/status
curl http://192.168.2.5:8080/api/v1/tracks/TRACK_ID/metadata
curl http://192.168.2.5:8080/api/v1/duplicates
```

Duplicate groups prefer SHA-256 file hashes and return the matching tracks. Manually created records without a hash remain backward-compatible; scanned records receive `fileHash` and `metadataSource`.

## Mixxx playlist import

Mixxx `.txt` playlists can be imported from a read-only, explicitly configured directory. The importer reads `#EXTM3U`, `#EXTINF` and following path lines, derives the category from each filename, deduplicates by category plus mapped Mixxx path, and stores both the original UNC path and the safe mapped path. Paths outside `PLAYLIST_SOURCE_PREFIX` or containing traversal segments are ignored.

```bash
curl -X POST http://192.168.2.5:8080/api/v1/playlists/import
curl http://192.168.2.5:8080/api/v1/playlists/import/status
curl "http://192.168.2.5:8080/api/v1/playlists?category=funkalles&pageSize=100"
```

The supplied Windows files can be mounted locally with `PLAYLIST_DIR=C:/Users/weze1/Music/Mixxx/PlayLists/documents` (PowerShell/Docker Desktop) or copied to a NAS share. No `C:` path is hardcoded into the image. For Synology, use for example `PLAYLIST_DIR=/volume1/docker/dj-library-api/playlists` and copy the six `.txt` files there. Keep `PLAYLIST_SOURCE_PREFIX=//stream-vught-nl/Dj/Music/` for the provided UNC paths; they become `/music/...` Mixxx paths through `MUSIC_PATH=/music/`.

## Synology Docker deployment

The image is multi-stage and contains the compiled application, Prisma Client and Prisma CLI; runtime does not require Node.js or npm on the NAS. The supported Prisma target for this image is **linux/arm64**, which covers current 64-bit Synology ARM NAS models. Prisma's SQLite native engine does not provide a compatible ARMv7 target, so 32-bit ARM Synology models cannot run this image reliably.

Install Docker/Container Manager and Buildx on the NAS, copy this repository to a shared folder, then build and start:

```bash
docker buildx build --platform linux/arm64 -t dj-library-api:latest --load .
SEED_DATABASE=true docker compose up -d
docker compose ps
docker compose logs -f api
```

Alternatively, let Compose build the image:

```bash
SEED_DATABASE=true docker compose up -d --build
```

Set `MUSIC_DIR` in `.env` to the Synology music share, for example `/volume1/music`. Compose mounts it read-only at `/music`; store matching track `filePath` values such as `/music/house/track.mp3`.

For Raspberry Pi or Armbian ARM64, use the same Compose mapping and build command; only the host share changes, for example `MUSIC_DIR=/srv/music`. Keep `MUSIC_ROOT=/music` inside the container and `MUSIC_PATH=/music/` for Mixxx-compatible playlists. Do not expose or accept a host path through the API.

The scanner uses one read-only music volume:

```yaml
volumes:
  - /volume1/music:/music:ro       # Synology
  # - /srv/music:/music:ro         # Raspberry Pi / Armbian
```

The SQLite database is stored in the named Docker volume `dj_library_data`, mounted at `/app/data`; it survives container recreation. `SEED_DATABASE=true` is safe to use repeatedly because seed rows are inserted only when the same title and artist do not already exist. Set it back to `false` after the first deployment if desired. The container applies the Prisma schema with `prisma db push` before starting the API, and restarts automatically unless stopped.

If Buildx reports a platform mismatch, use an explicit arm64 command:

```bash
docker buildx build --platform linux/arm64 -t dj-library-api:latest --load .
docker run --rm --platform linux/arm64 -p 3000:3000 \
  -e DATABASE_URL=file:/app/data/dev.db \
  -v dj_library_data:/app/data \
  dj-library-api:latest
```

## API

Tracks support `title`, `artist`, `album`, `genre`, `bpm`, `key`, `durationSeconds`, `rating` (1-5), `tags` and `filePath`.

```bash
# Create
curl -X POST http://localhost:3000/api/v1/tracks ^
  -H "Content-Type: application/json" ^
  -d "{\"title\":\"My Track\",\"artist\":\"My Artist\",\"genre\":\"House\",\"bpm\":124,\"rating\":5,\"tags\":[\"peak-time\"]}"

# List, search, filter, paginate and sort
curl "http://localhost:3000/api/v1/tracks?search=house&page=1&pageSize=20&sortBy=rating&sortOrder=desc"

# Details, update and delete
curl http://localhost:3000/api/v1/tracks/TRACK_ID
curl -X PATCH http://localhost:3000/api/v1/tracks/TRACK_ID -H "Content-Type: application/json" -d "{\"rating\":4}"
curl -X DELETE http://localhost:3000/api/v1/tracks/TRACK_ID
```

## Scripts

- `npm run dev` - development server with reload
- `npm run build` - compile TypeScript
- `npm test` - generate Prisma client, sync the test database and run tests
- `npm run db:push` - apply the Prisma schema to SQLite
- `npm run db:seed` - insert development seed tracks
