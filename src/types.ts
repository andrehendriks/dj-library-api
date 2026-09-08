export interface TrackResponse {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  genre: string | null;
  bpm: number | null;
  key: string | null;
  durationSeconds: number | null;
  rating: number | null;
  tags: string[];
  filePath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TrackListResponse {
  data: TrackResponse[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}
