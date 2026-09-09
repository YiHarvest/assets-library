import { z } from "zod";

const policySchema = z.object({
  version: z.string().min(1), validated: z.boolean(), vectorEnabled: z.boolean(), lexicalEnabled: z.boolean(),
  vectorTopK: z.number().int().min(1).max(1000), lexicalTopK: z.number().int().min(1).max(1000),
  expansionTopK: z.number().int().min(1).max(1000), numCandidates: z.number().int().min(1).max(10000),
  rrfK: z.number().int().positive(), maxEligibleIds: z.number().int().min(1).max(65536),
  semanticThreshold: z.number().min(-1).max(1), lexicalMinScore: z.number().nonnegative(),
  lexicalMinimumShouldMatch: z.string().min(1), includeMetadata: z.boolean(),
  weights: z.object({ name: z.number().nonnegative(), humanTags: z.number().nonnegative(), modelTags: z.number().nonnegative(),
    topics: z.number().nonnegative(), exactName: z.number().nonnegative(), exactHumanTags: z.number().nonnegative(),
    exactModelTags: z.number().nonnegative(), exactTopics: z.number().nonnegative() }).strict(),
}).strict().superRefine((policy, context) => {
  if ((!policy.vectorEnabled && !policy.lexicalEnabled) || policy.expansionTopK < Math.max(policy.vectorTopK, policy.lexicalTopK)) {
    context.addIssue({ code: "custom", message: "召回路必须至少启用一个，扩窗不能小于初始窗口。" });
  }
});

export type RecallPolicy = z.infer<typeof policySchema>;
export function parseRecallPolicy(value: unknown) { return policySchema.parse(value); }

/** Experiment starting point only. No quality claims or production cutover eligibility. */
export const experimentalRecallPolicy: RecallPolicy = {
  version: "v2-context-experiment-4", validated: false, vectorEnabled: true, lexicalEnabled: true,
  vectorTopK: 100, lexicalTopK: 100, expansionTopK: 200, numCandidates: 200, rrfK: 60, maxEligibleIds: 65536,
  semanticThreshold: 0.5, lexicalMinScore: 0, lexicalMinimumShouldMatch: "75%", includeMetadata: true,
  weights: { name: 2, humanTags: 2, modelTags: 1, topics: 1, exactName: 4, exactHumanTags: 4, exactModelTags: 2, exactTopics: 2 },
};
