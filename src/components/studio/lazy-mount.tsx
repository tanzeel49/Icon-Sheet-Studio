"use client";

/**
 * ICON SHEET STUDIO — LazyMount.
 * IntersectionObserver-driven mounting for expensive sheet previews and
 * icon library thumbnails. Keeps 1000+ icon collections smooth.
 */

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export function LazyMount({
  minHeight = 160,
  className,
  children,
  rootMargin = "300px",
}: {
  minHeight?: number;
  className?: string;
  children: React.ReactNode;
  rootMargin?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    if (typeof IntersectionObserver === "undefined") {
      const fallback = setTimeout(() => setVisible(true), 0);
      return () => clearTimeout(fallback);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible, rootMargin]);

  return (
    <div ref={ref} className={cn(className)} style={visible ? undefined : { minHeight }}>
      {visible ? children : <div className="h-full w-full rounded-lg bg-muted/40 animate-pulse" />}
    </div>
  );
}
