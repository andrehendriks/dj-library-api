import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { parseFile } from "music-metadata";
import type { PrismaClient, Track } from "@prisma/client";

const AUDIO_EXTENSIONS = new Set([".mp3", ".flac", ".wav", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".aiff", ".alac"]);

export interface ScanStatus {
  state: "idle" | "running" | "completed" | "failed";
  startedAt: string | null;
  finishedAt: string | null;
  scanned: number;
  imported: number;
  updated: number;
  skipped: number;
  errors: number;
  error: string | null;
}

export interface MusicConfig {
  root: string;
  publicPath: string;
}

const status: ScanStatus = {
  state: "idle", startedAt: null, finishedAt: null, scanned: 0, imported: 0,
  updated: 0, skipped: 0, errors: 0, error: null
};

export function getMusicConfig(): MusicConfig {
  const root = path.resolve(process.env.MUSIC_ROOT ?? "/music");
  const publicPath = process.env.MUSIC_PATH ?? process.env.MUSIC_PATH_PREFIX ?? "/music/";
  if (!publicPath.startsWith("/") || !publicPath.endsWith("/")) {
    throw new Error("MUSIC_PATH must be an absolute URL path ending with /");
  }
  return { root, publicPath };
}

export function getScanStatus(): ScanStatus {
  return { ...status };
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function walk(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const candidate = path.join(current, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...await walk(root, candidate));
    else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(candidate);
  }
  return files;
}

async function sha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function fallbackTitle(filePath: string): string {
  return path.basename(filePath, path.extname(filePath)).replace(/[_-]+/g, " ").trim() || "Untitled";
}

function publicFilePath(filePath: string, config: MusicConfig): string {
  const relative = path.relative(config.root, filePath).split(path.sep).join("/");
  return `${config.publicPath}${relative}`;
}

async function readTrack(filePath: string, config: MusicConfig) {
  const [fileStat, hash] = await Promise.all([stat(filePath), sha256(filePath)]);
  let metadataSource = "fallback";
  let metadata: Awaited<ReturnType<typeof parseFile>> | null = null;
  try {
    metadata = await parseFile(filePath, { duration: true, skipCovers: true });
    metadataSource = "music-metadata";
  } catch {
    // Some files have unsupported or damaged tags; keep the file importable.
  }
  const common = metadata?.common;
  const format = metadata?.format;
  return {
    title: common?.title?.trim() || fallbackTitle(filePath),
    artist: common?.artist?.trim() || "Unknown artist",
    album: common?.album?.trim() || null,
    genre: common?.genre?.[0]?.trim() || null,
    bpm: common?.bpm ?? null,
    key: common?.key?.trim() || null,
    durationSeconds: format?.duration ? Math.round(format.duration) : Math.max(1, Math.round(fileStat.size / 16000)),
    filePath: publicFilePath(filePath, config),
    fileHash: hash,
    metadataSource
  };
}

export async function scanMusic(prisma: PrismaClient): Promise<ScanStatus> {
  if (status.state === "running") return getScanStatus();
  const config = getMusicConfig();
  status.state = "running";
  status.startedAt = new Date().toISOString();
  status.finishedAt = null;
  status.scanned = 0;
  status.imported = 0;
  status.updated = 0;
  status.skipped = 0;
  status.errors = 0;
  status.error = null;
  try {
    await access(config.root);
    const root = await realpath(config.root);
    const files = await walk(root);
    for (const file of files) {
      status.scanned += 1;
      try {
        const data = await readTrack(file, { ...config, root });
        const existing = await prisma.track.findFirst({ where: { filePath: data.filePath } });
        if (existing) {
          await prisma.track.update({ where: { id: existing.id }, data });
          status.updated += 1;
        } else {
          await prisma.track.create({ data });
          status.imported += 1;
        }
      } catch {
        status.errors += 1;
      }
    }
    status.state = "completed";
  } catch (error) {
    status.state = "failed";
    status.error = error instanceof Error ? error.message : "Music scan failed";
  } finally {
    status.finishedAt = new Date().toISOString();
  }
  return getScanStatus();
}

export async function findDuplicateGroups(prisma: PrismaClient) {
  const tracks = await prisma.track.findMany({ orderBy: [{ fileHash: "asc" }, { artist: "asc" }, { title: "asc" }] });
  const groups = new Map<string, Track[]>();
  for (const track of tracks) {
    const signal = track.fileHash ?? `metadata:${track.artist.trim().toLowerCase()}|${track.title.trim().toLowerCase()}|${track.durationSeconds ?? 0}`;
    const group = groups.get(signal) ?? [];
    group.push(track);
    groups.set(signal, group);
  }
  return [...groups.entries()].filter(([, group]) => group.length > 1).map(([signal, group]) => ({
    signal,
    match: group[0]?.fileHash ? "sha256" : "metadata",
    tracks: group
  }));
}
