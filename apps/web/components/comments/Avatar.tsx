"use client";

import { useMemo } from "react";
import {
  Avatar as AvatarRoot,
  AvatarFallback,
} from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { identityColor } from "@/lib/identity-color";

/**
 * A name-only avatar: initials on a deterministic, AA-legible color derived from
 * the name via the shared `identityColor` (the same hue used for that person's
 * text marks). No image source in v1 (participants are name-only).
 */

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export function Avatar({
  name,
  size = "default",
  animateIn = false,
  className,
}: {
  name: string;
  size?: "default" | "sm" | "lg";
  /** Pop this avatar in (used when it is a NEWLY-added badge participant). */
  animateIn?: boolean;
  className?: string;
}) {
  const { background, label } = useMemo(
    () => ({ background: identityColor(name), label: initials(name) }),
    [name],
  );

  return (
    <AvatarRoot
      size={size}
      className={cn(animateIn && "motion-safe:animate-badge-pop", className)}
    >
      <AvatarFallback
        className={cn("font-medium text-white")}
        style={{ backgroundColor: background }}
      >
        {label}
      </AvatarFallback>
    </AvatarRoot>
  );
}

Avatar.displayName = "Avatar";
