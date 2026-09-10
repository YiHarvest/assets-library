interface Segment { text: string; group_id: number[] }

/** Grammatical fragments and deictic openings need their supplied sentence group. */
export function requiresRecallContext(text: string) {
  return /^(?:的|这|那|它|其|而且|那么|全部|全都|丝毫)|^(?:是|都|也)一(?:个)?样|(?:已经|正在|应该是|属于|为了|不会|不能)$/u.test(text.trim());
}

/** group_id is [position, length], not a globally unique group identifier. */
export function segmentRecallContexts(segments: readonly Segment[]): string[] {
  const groups: Array<{ start: number; end: number; valid: boolean }> = [];
  for (let start = 0; start < segments.length;) {
    const [position, length] = segments[start].group_id;
    const valid = position === 1 && Number.isInteger(length) && length > 0 && start + length <= segments.length &&
      segments.slice(start, start + length).every((segment, offset) =>
        segment.group_id[0] === offset + 1 && segment.group_id[1] === length);
    const end = start + (valid ? length : 1);
    groups.push({ start, end, valid });
    start = end;
  }
  const contexts: string[] = [];
  groups.forEach((group, index) => {
    // 当前组完成碎片；只有指代或残缺开头才补上文，避免换主题后仍混入上一段。
    const current = segments.slice(group.start, group.end).map(segment => segment.text.trim()).join("，");
    const needsAntecedent = !group.valid || /它|这|那|该|其|前者|后者|^(?:是|的|也|还|就)/u.test(current);
    const start = needsAntecedent ? groups[Math.max(0, index - 1)].start : group.start;
    const context = Array.from(segments.slice(start, group.end).map((segment) => segment.text.trim()).filter(Boolean).join("，"))
      .slice(-1024).join("");
    for (let i = group.start; i < group.end; i++) contexts[i] = context;
  });
  return contexts;
}
