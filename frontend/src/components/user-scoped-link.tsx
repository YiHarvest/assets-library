"use client";

import { useSearchParams } from "next/navigation";
import type { ComponentProps } from "react";
import { BaseLink } from "@/components/base-link";
import { withUserScope } from "@/lib/user-scope";

export function UserScopedLink({ href, ...props }: ComponentProps<typeof BaseLink>) {
  const parameters = useSearchParams();
  const userId = parameters.get("user_id");
  const scopedHref = typeof href === "string" ? withUserScope(href, userId) : href;
  return <BaseLink href={scopedHref} {...props} />;
}
