type StoredTag = {
  value: string;
  source: "model" | "human";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unique(values: string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Preserve the old UI's category:value information inside the v1 string tag. */
export function categorizedAnalysisTags(result: unknown) {
  if (!isRecord(result) || !isRecord(result.tags)) return [];
  const values: string[] = [];
  for (const [rawCategory, rawTags] of Object.entries(result.tags)) {
    const category = rawCategory.trim();
    if (!category || !Array.isArray(rawTags)) continue;
    for (const rawTag of rawTags) {
      if (typeof rawTag !== "string" || !rawTag.trim()) continue;
      values.push(`${category}:${rawTag.trim()}`);
    }
  }
  return unique(values);
}

/** Model links can be reconstructed from analysis JSON; human edits stay exact. */
export function presentAssetTags(rows: StoredTag[], analysis: unknown) {
  const human = rows
    .filter((row) => row.source === "human")
    .map((row) => row.value.trim())
    .filter(Boolean);
  const modelRows = rows.filter((row) => row.source === "model");
  const categorized = modelRows.length ? categorizedAnalysisTags(analysis) : [];
  const model = categorized.length
    ? categorized
    : modelRows.map((row) => row.value.trim()).filter(Boolean);
  return unique([...model, ...human]);
}

/** category:value filters also match rows written before categories were restored. */
export function normalizedTagCandidates(value: string) {
  const normalized = value.trim().toLocaleLowerCase();
  const separator = normalized.indexOf(":");
  const legacyValue = separator >= 0 ? normalized.slice(separator + 1).trim() : "";
  return unique([normalized, legacyValue].filter(Boolean));
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizedTimedEntries(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const start = numberValue(entry.start_seconds ?? entry.startSeconds);
    const end = numberValue(entry.end_seconds ?? entry.endSeconds);
    const summary = stringOrNull(entry.summary);
    return start !== null && end !== null && summary
      ? [{ start_seconds: start, end_seconds: end, summary }]
      : [];
  });
}

/** Normalize old camelCase analysis JSON and current snake_case analysis JSON. */
export function publicAssetAnalysis(mediaType: "image" | "video", value: unknown) {
  const result = isRecord(value) ? value : {};
  if (mediaType === "image") {
    const ocr = isRecord(result.ocr) ? result.ocr : {};
    const text = stringOrNull(ocr.text);
    const unavailableReason = stringOrNull(
      ocr.unavailable_reason ?? ocr.unavailableReason,
    );
    return {
      ocr: {
        text,
        unavailable_reason: text ? null : (unavailableReason ?? "无可识别文本"),
      },
    };
  }

  const rawMoments = result.key_moments ?? result.keyMoments;
  const keyMoments = Array.isArray(rawMoments)
    ? rawMoments.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const seconds = numberValue(entry.seconds);
        const summary = stringOrNull(entry.summary);
        return seconds !== null && summary ? [{ seconds, summary }] : [];
      })
    : [];
  return {
    topics: Array.isArray(result.topics)
      ? result.topics.filter((topic): topic is string => typeof topic === "string")
      : [],
    visual_segments: normalizedTimedEntries(
      result.visual_segments ?? result.visualSegments,
    ),
    key_moments: keyMoments,
    timeline: normalizedTimedEntries(result.timeline),
  };
}
