interface Segment { text: string; group_id: number[] }

/** group_id is [position, length], not a globally unique group identifier. */
export function segmentRecallContexts(segments: readonly Segment[]): string[] {
  const groups: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < segments.length;) {
    const [position, length] = segments[start].group_id;
    const valid = position === 1 && Number.isInteger(length) && length > 0 && start + length <= segments.length &&
      segments.slice(start, start + length).every((segment, offset) =>
        segment.group_id[0] === offset + 1 && segment.group_id[1] === length);
    const end = start + (valid ? length : 1);
    groups.push({ start, end });
    start = end;
  }
  const contexts: string[] = [];
  groups.forEach((group, index) => {
    // The current sentence completes fragments; the preceding sentence supplies
    // antecedents without allowing the rest of the script to dominate the query.
    const start = groups[Math.max(0, index - 1)].start;
    const context = Array.from(segments.slice(start, group.end).map((segment) => segment.text.trim()).filter(Boolean).join("，"))
      .slice(-1024).join("");
    for (let i = group.start; i < group.end; i++) contexts[i] = context;
  });
  return contexts;
}
