export const MAX_VIDEO_FRAMES = 5;
export const SHORT_VIDEO_MAX_FRAMES = 3;
export const SHORT_VIDEO_THRESHOLD_SECONDS = 10;

export interface VideoFrameUploadMetadata {
  durationSeconds: number;
  timestamps: number[];
}

export interface StoredVideoFrame {
  filename: string;
  timestampSeconds: number;
}

export interface VideoFrameManifest {
  durationSeconds: number;
  frames: StoredVideoFrame[];
}

export function videoFrameTimestamps(durationSeconds: number) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("Video duration must be a positive finite number.");
  }
  const frameLimit =
    durationSeconds < SHORT_VIDEO_THRESHOLD_SECONDS
      ? SHORT_VIDEO_MAX_FRAMES
      : MAX_VIDEO_FRAMES;
  const count = Math.min(
    frameLimit,
    Math.max(1, Math.ceil(durationSeconds)),
  );
  return Array.from({ length: count }, (_, index) =>
    Number(
      (((index + 0.5) / count) * durationSeconds).toFixed(3),
    ),
  );
}
