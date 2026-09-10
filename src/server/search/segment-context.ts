interface Segment { text: string; group_id: number[] }

/** Grammatical fragments and deictic openings need their supplied sentence group. */
export function requiresRecallContext(text: string) {
  return /^(?:的|这|那|它|其|而且|那么|全部|全都|丝毫|还能|不只)|^(?:是|都|也)一(?:个)?样|(?:已经|正在|应该是|属于|为了|不会|不能)$/u.test(text.trim());
}

/** group_id is [position, length], not a globally unique group identifier. */
export function segmentRecallContexts(segments: readonly Segment[], text = ""): string[] {
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
  // 业务 group_id 是排版/语音分组，可能跨越多个概念；原文句界优先，无法对齐时保留旧语境。
  const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  let end = 0;
  const sentences = (text.match(/[^。！？!?；;\n]+[。！？!?；;]?/gu) ?? []).map(sentence => {
    const start = end;
    end += normalize(sentence).length;
    return { text: sentence.trim(), start, end };
  }).filter(sentence => sentence.end > sentence.start);
  if (sentences.length < 2) return contexts;
  const source = normalize(text);
  let cursor = 0;
  segments.forEach((segment, index) => {
    const target = normalize(segment.text);
    const start = target ? source.indexOf(target, cursor) : -1;
    if (start < 0) return;
    cursor = start + target.length;
    const first = sentences.findIndex(sentence => sentence.end > start);
    const last = sentences.findIndex(sentence => sentence.end >= cursor);
    if (first < 0 || last < first) return;
    const needsAntecedent = /^(?:它|这|那|该|其|前者|后者|而且|那么|也|还|就)|它/u.test(sentences[first].text);
    contexts[index] = sentences.slice(needsAntecedent ? Math.max(0, first - 1) : first, last + 1)
      .map(sentence => sentence.text).join("").slice(-1024);
  });
  return contexts;
}
