import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";

export interface PlaylistImportStatus {
  state: "idle" | "running" | "completed" | "failed";
  startedAt: string | null;
  finishedAt: string | null;
  files: number;
  entries: number;
  imported: number;
  updated: number;
  skipped: number;
  errors: number;
  error: string | null;
}

const status: PlaylistImportStatus = {
  state: "idle", startedAt: null, finishedAt: null, files: 0, entries: 0,
  imported: 0, updated: 0, skipped: 0, errors: 0, error: null
};

export interface PlaylistConfig {
  root: string;
  sourcePrefix: string;
  mixxxPath: string;
}

export function getPlaylistConfig(): PlaylistConfig {
  const root = path.resolve(process.env.PLAYLIST_ROOT ?? "/playlists");
  const sourcePrefix = (process.env.PLAYLIST_SOURCE_PREFIX ?? "//stream-vught-nl/Dj/Music/").replace(/\\/g, "/");
  const mixxxPath = process.env.MUSIC_PATH ?? process.env.MUSIC_PATH_PREFIX ?? "/music/";
  if (!sourcePrefix.endsWith("/") || !mixxxPath.startsWith("/") || !mixxxPath.endsWith("/")) {
    throw new Error("PLAYLIST_SOURCE_PREFIX must end with / and MUSIC_PATH must be an absolute URL path ending with /");
  }
  return { root, sourcePrefix, mixxxPath };
}

export function getPlaylistImportStatus(): PlaylistImportStatus {
  return { ...status };
}

function categoryFromFilename(fileName: string): string {
  return path.basename(fileName, path.extname(fileName)).trim().toLowerCase() || "uncategorized";
}

export function mapPlaylistPath(sourcePath: string, config: PlaylistConfig): string | null {
  const normalized = sourcePath.trim().replace(/\\/g, "/");
  if (!normalized.startsWith(config.sourcePrefix) || normalized.includes("\0")) return null;
  const relative = normalized.slice(config.sourcePrefix.length);
  const segments = relative.split("/");
  if (!relative || segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return `${config.mixxxPath}${relative}`;
}

export interface ParsedPlaylistEntry {
  duration: number | null;
  title: string | null;
  artist: string | null;
  sourcePath: string;
}

export function parsePlaylist(content: string, config: PlaylistConfig): ParsedPlaylistEntry[] {
  const entries: ParsedPlaylistEntry[] = [];
  let extinf: { duration: number | null; title: string | null; artist: string | null } = { duration: null, title: null, artist: null };
  const seen = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.toUpperCase() === "#EXTM3U") continue;
    if (line.toUpperCase().startsWith("#EXTINF")) {
      const value = line.slice(line.indexOf(":") + 1);
      const comma = value.indexOf(",");
      const duration = Number.parseInt(comma >= 0 ? value.slice(0, comma) : value, 10);
      const title = comma >= 0 ? value.slice(comma + 1).trim() : null;
      const separator = title?.indexOf(" - ") ?? -1;
      extinf = {
        duration: Number.isFinite(duration) ? duration : null,
        title: title ? (separator >= 0 ? title.slice(separator + 3).trim() : title) : null,
        artist: title && separator >= 0 ? title.slice(0, separator).trim() : null
      };
      continue;
    }
    if (line.startsWith("#")) continue;
    const mapped = mapPlaylistPath(line, config);
    if (!mapped || seen.has(mapped)) continue;
    seen.add(mapped);
    entries.push({ ...extinf, sourcePath: line });
    extinf = { duration: null, title: null, artist: null };
  }
  return entries;
}

export async function importPlaylists(prisma: PrismaClient): Promise<PlaylistImportStatus> {
  if (status.state === "running") return getPlaylistImportStatus();
  const config = getPlaylistConfig();
  Object.assign(status, { state: "running", startedAt: new Date().toISOString(), finishedAt: null, files: 0, entries: 0, imported: 0, updated: 0, skipped: 0, errors: 0, error: null });
  try {
    await access(config.root);
    const files = (await readdir(config.root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".txt")
      .map((entry) => entry.name);
    const pending = new Map<string, { category: string; sourceFile: string; sourcePath: string; mixxxPath: string; title: string | null; artist: string | null; duration: number | null }>();
    for (const fileName of files) {
      status.files += 1;
      const category = categoryFromFilename(fileName);
      const content = await readFile(path.join(config.root, fileName), "utf8");
      const entries = parsePlaylist(content, config);
      status.entries += entries.length;
      for (const entry of entries) {
        const mixxxPath = mapPlaylistPath(entry.sourcePath, config);
        if (!mixxxPath) {
          status.skipped += 1;
          continue;
        }
        pending.set(`${category}\0${mixxxPath}`, { category, sourceFile: fileName, sourcePath: entry.sourcePath, mixxxPath, title: entry.title, artist: entry.artist, duration: entry.duration });
      }
    }
    const values = [...pending.values()];
    for (let offset = 0; offset < values.length; offset += 400) {
      const chunk = values.slice(offset, offset + 400);
      const existing = await prisma.playlistEntry.findMany({
        where: { OR: chunk.map((entry) => ({ category: entry.category, mixxxPath: entry.mixxxPath })) },
        select: { id: true, category: true, mixxxPath: true }
      });
      const existingKeys = new Set(existing.map((entry) => `${entry.category}\0${entry.mixxxPath}`));
      await prisma.playlistEntry.createMany({
        data: chunk.filter((entry) => !existingKeys.has(`${entry.category}\0${entry.mixxxPath}`))
      });
      status.imported += chunk.filter((entry) => !existingKeys.has(`${entry.category}\0${entry.mixxxPath}`)).length;
      status.updated += chunk.filter((entry) => existingKeys.has(`${entry.category}\0${entry.mixxxPath}`)).length;
    }
    status.state = "completed";
  } catch (error) {
    status.state = "failed";
    status.error = error instanceof Error ? error.message : "Playlist import failed";
  } finally {
    status.finishedAt = new Date().toISOString();
  }
  return getPlaylistImportStatus();
}
