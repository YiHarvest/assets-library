import { createHash, timingSafeEqual } from "node:crypto";

export function readBearerCredential(authorization: string | null) {
  if (!authorization) return undefined;
  const match = /^Bearer[ \t]+([^ \t]+)$/i.exec(authorization);
  return match?.[1];
}

export function webUiLockKeyMatches(
  candidate: string | null | undefined,
  expected: string,
) {
  if (!candidate) return false;
  const candidateHash = createHash("sha256").update(candidate).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(candidateHash, expectedHash);
}
