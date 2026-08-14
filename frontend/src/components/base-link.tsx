import Link from "next/link";
import type { ComponentProps } from "react";
import { prefixedHref } from "@/lib/base-path";

export function BaseLink({ href, ...props }: ComponentProps<typeof Link>) {
  const nextHref = typeof href === "string" ? prefixedHref(href) : href;
  return <Link href={nextHref} {...props} />;
}
