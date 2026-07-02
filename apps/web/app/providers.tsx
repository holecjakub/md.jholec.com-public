"use client";
import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";
import { HapticBridge } from "@/components/HapticBridge";
import { ToastProvider } from "@/components/ui/toast";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <HapticBridge />
      <ToastProvider>{children}</ToastProvider>
    </ThemeProvider>
  );
}
