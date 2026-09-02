/** Pure helpers shared by lexical recall and semantic re-ranking. */

export const DEFAULT_RELEVANCE_THRESHOLDS = {
  strongKeyword: 0.7,
  typoFallback: 0.4,
  semantic: 0.55,
  hybrid: 0.65,
} as const;

export const DEFAULT_HYBRID_WEIGHTS = {
  lexical: 0.4,
  semantic: 0.6,
} as const;

export type KnownSearchTagCategory =
  | "scene"
  | "style"
  | "form"
  | "object"
  | "person"
  | "color_composition";
export type SearchTagCategory = KnownSearchTagCategory | (string & {});

export type SearchIntent = "general" | "scene" | "style" | "form";

export type LexicalMatchType =
  | "exact"
  | "alias"
  | "prefix"
  | "contains"
  | "typo";

export interface SearchableTag {
  value: string;
  category: SearchTagCategory;
}

export interface TagMatchEvidence {
  token: string;
  tag: string;
  category: SearchTagCategory;
  matchType: LexicalMatchType;
  quality: number;
  categoryWeight: number;
  score: number;
}

export interface KeywordRelevance {
  score: number;
  coverage: number;
  matchedTokens: string[];
  unmatchedTokens: string[];
  evidence: TagMatchEvidence[];
}

export interface KeywordScoringOptions {
  allowTypo?: boolean;
  intent?: SearchIntent;
  categoryWeights?: Partial<Record<SearchTagCategory, number>>;
  aliases?: readonly (readonly string[])[];
}

export const DEFAULT_BUSINESS_ALIASES: readonly (readonly string[])[] = [
  ["ai", "aigc", "人工智能", "生成式人工智能", "智能科技"],
];

const MATCH_QUALITY: Readonly<Record<LexicalMatchType, number>> = {
  exact: 1,
  alias: 0.95,
  prefix: 0.85,
  contains: 0.72,
  typo: 0.55,
};

const CATEGORY_WEIGHTS: Readonly<
  Record<SearchIntent, Readonly<Record<KnownSearchTagCategory, number>>>
> = {
  general: {
    scene: 1,
    style: 0.9,
    form: 0.9,
    object: 1,
    person: 1,
    color_composition: 0.75,
  },
  scene: {
    scene: 1,
    style: 0.65,
    form: 0.65,
    object: 0.85,
    person: 0.85,
    color_composition: 0.6,
  },
  style: {
    scene: 0.7,
    style: 1,
    form: 0.9,
    object: 0.7,
    person: 0.7,
    color_composition: 0.85,
  },
  form: {
    scene: 0.7,
    style: 0.9,
    form: 1,
    object: 0.7,
    person: 0.7,
    color_composition: 0.8,
  },
};

const SCENE_INTENT_WORDS = new Set(["场景", "环境", "地点", "scene"]);
const STYLE_INTENT_WORDS = new Set(["风格", "画风", "视觉风格", "style"]);
const FORM_INTENT_WORDS = new Set(["形式", "片型", "视频形式", "form"]);
const latinCharacterPattern = /[a-z0-9]/;
const latinTokenPattern = /^[a-z0-9_-]+$/;
const hanTokenPattern = /^\p{Script=Han}+$/u;

export function clampRelevanceScore(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Number(Math.min(1, Math.max(0, value)).toFixed(6));
}

/** NFKC keeps full-width input and Latin aliases comparable without changing semantics. */
export function normalizeSearchText(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

/** Semantic text is normalized only; it must be embedded as a complete sentence. */
export function normalizeSemanticText(value: string) {
  return normalizeSearchText(value);
}

function normalizedAliasGroups(aliases: readonly (readonly string[])[]) {
  return aliases.map((group) => [
    ...new Set(group.map(normalizeSearchText).filter(Boolean)),
  ]);
}

function protectedTerms(aliases: readonly (readonly string[])[]) {
  return [...new Set(normalizedAliasGroups(aliases).flat())].sort(
    (left, right) => Array.from(right).length - Array.from(left).length,
  );
}

function hasLatinBoundary(text: string, start: number, term: string) {
  if (!latinTokenPattern.test(term)) return true;
  const before = text[start - 1];
  const after = text[start + term.length];
  return (!before || !latinCharacterPattern.test(before)) &&
    (!after || !latinCharacterPattern.test(after));
}

function segmentUnprotectedText(text: string) {
  if (!text) return [];
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
    const segmented = [...segmenter.segment(text)]
      .filter((part) => part.isWordLike)
      .map((part) => normalizeSearchText(part.segment))
      .filter(Boolean);
    // Segmenter 会把罕见字/错别字拆成单字；把尾随单字并回相邻汉语词，
    // 否则“城巿”会退化成“城”的前缀命中，无法进入真正的 typo 层。
    return segmented.reduce<string[]>((tokens, token) => {
      const previous = tokens.at(-1);
      if (
        previous &&
        hanTokenPattern.test(previous) &&
        hanTokenPattern.test(token) &&
        Array.from(token).length === 1
      ) {
        tokens[tokens.length - 1] = `${previous}${token}`;
      } else {
        tokens.push(token);
      }
      return tokens;
    }, []);
  }
  return text.match(/[\p{Script=Han}]+|[\p{L}\p{N}_-]+/gu) ?? [];
}

/**
 * Tokenizes only keyword queries. Protected business terms are extracted first so
 * runtime-specific word segmentation cannot split aliases such as `人工智能`.
 */
export function tokenizeKeywordQuery(
  query: string,
  aliases: readonly (readonly string[])[] = DEFAULT_BUSINESS_ALIASES,
) {
  const text = normalizeSearchText(query);
  if (!text) return [];
  const protectedAliases = protectedTerms(aliases);
  const tokens: string[] = [];
  let plainStart = 0;
  let cursor = 0;

  while (cursor < text.length) {
    const matched = protectedAliases.find(
      (term) => text.startsWith(term, cursor) && hasLatinBoundary(text, cursor, term),
    );
    if (!matched) {
      cursor += 1;
      continue;
    }
    tokens.push(...segmentUnprotectedText(text.slice(plainStart, cursor)), matched);
    cursor += matched.length;
    plainStart = cursor;
  }
  tokens.push(...segmentUnprotectedText(text.slice(plainStart)));
  return [...new Set(tokens.filter(Boolean))];
}

export function detectSearchIntent(
  queryOrTokens: string | readonly string[],
): SearchIntent {
  const tokens = typeof queryOrTokens === "string"
    ? tokenizeKeywordQuery(queryOrTokens)
    : queryOrTokens.map(normalizeSearchText);
  if (tokens.some((token) => SCENE_INTENT_WORDS.has(token))) return "scene";
  if (tokens.some((token) => STYLE_INTENT_WORDS.has(token))) return "style";
  if (tokens.some((token) => FORM_INTENT_WORDS.has(token))) return "form";
  return "general";
}

function isIntentMarker(token: string) {
  return SCENE_INTENT_WORDS.has(token) ||
    STYLE_INTENT_WORDS.has(token) ||
    FORM_INTENT_WORDS.has(token);
}

function aliasGroupFor(
  term: string,
  aliases: readonly (readonly string[])[],
) {
  return normalizedAliasGroups(aliases).find((group) => group.includes(term));
}

function levenshteinWithinOne(left: string, right: string) {
  const leftCharacters = Array.from(left);
  const rightCharacters = Array.from(right);
  if (Math.abs(leftCharacters.length - rightCharacters.length) > 1) return false;
  let previous = Array.from({ length: rightCharacters.length + 1 }, (_, index) => index);
  for (const [leftIndex, leftCharacter] of leftCharacters.entries()) {
    const current = [leftIndex + 1];
    let rowMinimum = current[0];
    for (const [rightIndex, rightCharacter] of rightCharacters.entries()) {
      const value = Math.min(
        current[rightIndex] + 1,
        previous[rightIndex + 1] + 1,
        previous[rightIndex] + (leftCharacter === rightCharacter ? 0 : 1),
      );
      current.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > 1) return false;
    previous = current;
  }
  return previous[rightCharacters.length] === 1;
}

function typoEligible(left: string, right: string) {
  if (latinTokenPattern.test(left) && latinTokenPattern.test(right)) {
    return Array.from(left).length >= 4 && Array.from(right).length >= 4;
  }
  if (hanTokenPattern.test(left) && hanTokenPattern.test(right)) {
    return Array.from(left).length >= 2 && Array.from(right).length >= 2;
  }
  return false;
}

export function classifyTagMatch(
  tokenValue: string,
  tagValue: string,
  options: Pick<KeywordScoringOptions, "allowTypo" | "aliases"> = {},
): { matchType: LexicalMatchType; quality: number } | null {
  const token = normalizeSearchText(tokenValue);
  const tag = normalizeSearchText(tagValue);
  if (!token || !tag) return null;
  if (token === tag) return { matchType: "exact", quality: MATCH_QUALITY.exact };

  const aliases = options.aliases ?? DEFAULT_BUSINESS_ALIASES;
  const tokenAliasGroup = aliasGroupFor(token, aliases);
  if (tokenAliasGroup?.includes(tag)) {
    return { matchType: "alias", quality: MATCH_QUALITY.alias };
  }

  const shortLatin = latinTokenPattern.test(token) && Array.from(token).length < 4;
  if (!shortLatin && tag.startsWith(token)) {
    return { matchType: "prefix", quality: MATCH_QUALITY.prefix };
  }
  if (!shortLatin && tag.includes(token)) {
    return { matchType: "contains", quality: MATCH_QUALITY.contains };
  }
  if (
    options.allowTypo &&
    !shortLatin &&
    typoEligible(token, tag) &&
    levenshteinWithinOne(token, tag)
  ) {
    return { matchType: "typo", quality: MATCH_QUALITY.typo };
  }
  return null;
}

export function categoryWeight(
  category: SearchTagCategory,
  intent: SearchIntent = "general",
  overrides: Partial<Record<SearchTagCategory, number>> = {},
) {
  const configured = overrides[category];
  const defaults = CATEGORY_WEIGHTS[intent] as Partial<
    Record<SearchTagCategory, number>
  >;
  return clampRelevanceScore(configured ?? defaults[category] ?? 0.8);
}

export function scoreKeywordRelevance(
  queryOrTokens: string | readonly string[],
  tags: readonly SearchableTag[],
  options: KeywordScoringOptions = {},
): KeywordRelevance {
  const tokens = [...new Set(
    (typeof queryOrTokens === "string"
      ? tokenizeKeywordQuery(queryOrTokens, options.aliases)
      : queryOrTokens.map(normalizeSearchText)).filter(Boolean),
  )];
  if (tokens.length === 0) {
    return {
      score: 0,
      coverage: 0,
      matchedTokens: [],
      unmatchedTokens: [],
      evidence: [],
    };
  }

  const intent = options.intent ?? detectSearchIntent(tokens);
  // “复古 风格”中的“风格”用于选择分类权重，不应被当成必须命中的业务标签。
  const scoringTokens = tokens.length > 1
    ? tokens.filter((token) => !isIntentMarker(token))
    : tokens;
  const effectiveTokens = scoringTokens.length ? scoringTokens : tokens;
  const evidence = effectiveTokens.flatMap((token) => {
    let best: TagMatchEvidence | null = null;
    for (const tag of tags) {
      const match = classifyTagMatch(token, tag.value, options);
      if (!match) continue;
      const weight = categoryWeight(tag.category, intent, options.categoryWeights);
      const candidate: TagMatchEvidence = {
        token,
        tag: normalizeSearchText(tag.value),
        category: tag.category,
        matchType: match.matchType,
        quality: match.quality,
        categoryWeight: weight,
        score: clampRelevanceScore(match.quality * weight),
      };
      if (!best || candidate.score > best.score) best = candidate;
    }
    return best ? [best] : [];
  });
  const matched = new Set(evidence.map((item) => item.token));
  const coverage = matched.size / effectiveTokens.length;
  const meanMatched = evidence.length
    ? evidence.reduce((sum, item) => sum + item.score, 0) / evidence.length
    : 0;

  return {
    score: clampRelevanceScore(meanMatched * coverage),
    coverage: clampRelevanceScore(coverage),
    matchedTokens: effectiveTokens.filter((token) => matched.has(token)),
    unmatchedTokens: effectiveTokens.filter((token) => !matched.has(token)),
    evidence,
  };
}

export function isBroadAiQuery(
  queryOrTokens: string | readonly string[],
  aliases: readonly (readonly string[])[] = DEFAULT_BUSINESS_ALIASES,
) {
  const tokens = typeof queryOrTokens === "string"
    ? tokenizeKeywordQuery(queryOrTokens, aliases)
    : queryOrTokens.map(normalizeSearchText).filter(Boolean);
  if (tokens.length !== 1) return false;
  const aiGroup = normalizedAliasGroups(aliases)[0] ?? [];
  return aiGroup.includes(tokens[0]);
}

export function hybridRelevanceScore(
  lexicalScore: number | null | undefined,
  semanticScore: number | null | undefined,
  weights: { lexical?: number; semantic?: number } = {},
) {
  const hasLexical = lexicalScore !== null && lexicalScore !== undefined;
  const hasSemantic = semanticScore !== null && semanticScore !== undefined;
  if (!hasLexical && !hasSemantic) return 0;
  if (!hasLexical) return clampRelevanceScore(semanticScore ?? 0);
  if (!hasSemantic) return clampRelevanceScore(lexicalScore ?? 0);

  const lexicalWeight = Math.max(0, weights.lexical ?? DEFAULT_HYBRID_WEIGHTS.lexical);
  const semanticWeight = Math.max(0, weights.semantic ?? DEFAULT_HYBRID_WEIGHTS.semantic);
  const totalWeight = lexicalWeight + semanticWeight;
  if (totalWeight === 0) return 0;
  return clampRelevanceScore(
    (clampRelevanceScore(lexicalScore) * lexicalWeight +
      clampRelevanceScore(semanticScore) * semanticWeight) /
      totalWeight,
  );
}

export type SearchInputMode = "keyword" | "semantic";

const semanticSentencePattern =
  /[。！？!?]|(?:帮我|我想|需要|希望|寻找|找一|如果|符合|适合|用于|画面中|镜头中|正在)|(?:一个|一位|有人).*(?:行走|奔跑|工作|交谈|跳舞|站立)|\b(?:a|an|the|who|that|with|showing|walking|running)\b/i;

/**
 * Routes concise labels to lexical recall and sentence-like descriptions to
 * embeddings. Space-separated label lists deliberately remain keyword queries.
 */
export function detectSearchInputMode(query: string): SearchInputMode {
  const normalized = normalizeSearchText(query);
  if (!normalized) return "keyword";
  if (semanticSentencePattern.test(normalized)) return "semantic";

  const whitespaceTerms = normalized.split(" ").filter(Boolean);
  if (whitespaceTerms.length > 1) {
    return "keyword";
  }

  const tokens = tokenizeKeywordQuery(normalized);
  const characterCount = Array.from(normalized.replace(/\s/g, "")).length;
  return tokens.length >= 5 || characterCount >= 12 ? "semantic" : "keyword";
}
