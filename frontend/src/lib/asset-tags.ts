export interface DisplayTag {
  category: string;
  value: string;
  raw: string;
}

/** Parse the v1 single-string tag back into the old detail view's grouping. */
export function displayTag(tag: string): DisplayTag {
  const raw = tag.trim();
  const separator = raw.indexOf(":");
  if (separator > 0 && raw.slice(separator + 1).trim()) {
    return {
      category: raw.slice(0, separator).trim(),
      value: raw.slice(separator + 1).trim(),
      raw,
    };
  }
  return { category: "custom", value: raw, raw };
}

export function groupDisplayTags(tags: string[]) {
  const groups = new Map<string, DisplayTag[]>();
  for (const tag of tags.map(displayTag).filter((item) => item.value)) {
    const current = groups.get(tag.category) ?? [];
    current.push(tag);
    groups.set(tag.category, current);
  }
  return [...groups.entries()];
}
