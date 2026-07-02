"use client";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Minimal, dependency-free toast system. A single bottom-left stack (clears the
 * bottom-right mobile FAB and the right-edge desktop pill). Built for transient
 * failure feedback with an optional Retry action — there was previously no way to
 * tell a user that posting a comment / reaction failed; it failed silently.
 */

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastInput {
  message: string;
  tone?: "error" | "info";
  action?: ToastAction;
}

interface ToastItem extends ToastInput {
  id: number;
}

interface ToastApi {
  toast: (t: ToastInput) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Returns the toast trigger. No-ops safely if no provider is mounted. */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? NOOP;
}
const NOOP: ToastApi = { toast: () => {} };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (t: ToastInput) => {
      const id = (idRef.current += 1);
      setToasts((prev) => [...prev, { ...t, id }]);
      // Errors with an action linger longer so the Retry is reachable; otherwise
      // auto-dismiss. The user can also dismiss manually.
      const ttl = t.action ? 8000 : 4000;
      setTimeout(() => dismiss(id), ttl);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <Toaster toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

function Toaster({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 left-4 z-[60] flex max-w-[min(92vw,26rem)] flex-col gap-2"
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={reduceMotion ? false : { opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 500, damping: 40 }}
            role={t.tone === "error" ? "alert" : "status"}
            className={cn(
              "pointer-events-auto flex items-center gap-3 rounded-lg border px-3.5 py-2.5 text-sm shadow-lg",
              "border-border bg-elevated text-foreground",
              t.tone === "error" && "border-destructive/40",
            )}
          >
            <span className="min-w-0 flex-1">{t.message}</span>
            {t.action ? (
              <button
                type="button"
                onClick={() => {
                  t.action!.onClick();
                  onDismiss(t.id);
                }}
                className="shrink-0 rounded-md px-2 py-1 font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t.action.label}
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => onDismiss(t.id)}
              className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X aria-hidden className="size-4" />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
