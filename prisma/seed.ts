import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const tracks = [
  {
    title: "Midnight City",
    artist: "M83",
    album: "Hurry Up, We're Dreaming",
    genre: "Synthpop",
    bpm: 105,
    key: "F# min",
    durationSeconds: 243,
    rating: 5,
    tags: ["warm-up", "80s"],
    filePath: "/music/m83-midnight-city.mp3"
  },
  {
    title: "One More Time",
    artist: "Daft Punk",
    album: "Discovery",
    genre: "House",
    bpm: 123,
    key: "F# min",
    durationSeconds: 320,
    rating: 5,
    tags: ["classic", "peak-time"],
    filePath: "/music/daft-punk-one-more-time.mp3"
  }
];

async function main(): Promise<void> {
  for (const track of tracks) {
    const existing = await prisma.track.findFirst({
      where: { title: track.title, artist: track.artist }
    });
    if (!existing) {
      await prisma.track.create({
        data: { ...track, tags: JSON.stringify(track.tags) }
      });
    }
  }
}

main()
  .then(async () => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exitCode = 1;
  });
