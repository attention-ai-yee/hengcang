import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("app-card", className)} {...props} />;
}

export function StatusPill({ tone = "neutral", children }: { tone?: "neutral" | "good" | "warn" | "danger"; children: React.ReactNode }) {
  const tones = {
    neutral: "bg-[#eef1ef] text-[#58655f]",
    good: "bg-[#dceee4] text-[#246044]",
    warn: "bg-[#fff0d5] text-[#8a570b]",
    danger: "bg-[#f8dfdc] text-[#91352f]",
  };
  return <span className={cn("inline-flex rounded-full px-2.5 py-1 text-xs font-bold", tones[tone])}>{children}</span>;
}

export function PageIntro({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="eyebrow mb-2">{eyebrow}</p>
        <h1 className="text-3xl font-semibold tracking-[-0.035em] text-[#17201c] md:text-4xl">{title}</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-[#65726c]">{description}</p>
      </div>
      {action}
    </div>
  );
}
