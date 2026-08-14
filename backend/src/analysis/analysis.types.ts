import { z } from "zod";

const nonEmptyChinese = z.string().trim().min(1).max(128).refine((value) => /\p{Script=Han}/u.test(value), "标签必须包含中文");
const tags = z.record(z.string(), z.array(nonEmptyChinese).max(30));

export const imageAnalysisSchema = z.object({
  kind: z.literal("image"),
  description: z.string().trim().max(5000),
  tags,
  ocr: z.object({
    text: z.string().max(100000).nullable(),
    unavailable_reason: z.string().max(1000).nullable(),
  }),
});

const range = z.object({
  start_seconds: z.number().nonnegative(),
  end_seconds: z.number().positive(),
  summary: z.string().trim().min(1).max(2000),
}).refine((value) => value.end_seconds > value.start_seconds, "结束时间必须大于开始时间");

export const videoAnalysisSchema = z.object({
  kind: z.literal("video"),
  description: z.string().trim().max(5000),
  topics: z.array(nonEmptyChinese).max(30),
  tags,
  visual_segments: z.array(range).max(1000),
  key_moments: z.array(z.object({
    seconds: z.number().nonnegative(),
    summary: z.string().trim().min(1).max(2000),
  })).max(1000),
  timeline: z.array(range).max(1000),
});

export const analysisSchema = z.discriminatedUnion("kind", [imageAnalysisSchema, videoAnalysisSchema]);
export type AnalysisResult = z.infer<typeof analysisSchema>;

