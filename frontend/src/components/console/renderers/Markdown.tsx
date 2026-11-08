"use client";

/** Compact dark markdown (prompts, results, chat). Nothing below 12 px. */

import { memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export const Markdown = memo(function Markdown({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}): ReactNode {
  return (
    <div
      className={`min-w-0 text-[13px] leading-relaxed text-slate-200 ${className}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => (
            <p className="mb-1.5 break-words last:mb-0">{children}</p>
          ),
          h1: ({ children }) => (
            <h1 className="mb-1 mt-2 border-b border-white/10 pb-0.5 text-sm font-bold text-slate-100">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-1 mt-2 text-sm font-bold text-slate-100">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-0.5 mt-1.5 text-[13px] font-bold text-slate-200">
              {children}
            </h3>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-slate-50">{children}</strong>
          ),
          em: ({ children }) => (
            <em className="italic text-slate-300">{children}</em>
          ),
          code: ({ children, className: cls }) =>
            cls?.startsWith("language-") ? (
              <code className="my-1 block overflow-x-auto whitespace-pre rounded-md border border-white/[0.07] bg-[#060A12] px-2.5 py-1.5 font-mono text-xs text-emerald-200">
                {children}
              </code>
            ) : (
              <code className="rounded border border-white/[0.07] bg-[#060A12] px-1 py-px font-mono text-xs text-emerald-200">
                {children}
              </code>
            ),
          pre: ({ children }) => (
            <pre className="my-1 overflow-x-auto">{children}</pre>
          ),
          ul: ({ children }) => (
            <ul className="my-1 list-disc space-y-0.5 pl-5">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-1 list-decimal space-y-0.5 pl-5">{children}</ol>
          ),
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="my-1 border-l-2 border-white/15 pl-2 italic text-slate-400">
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-300 underline decoration-sky-300/40 hover:text-sky-200"
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="my-1 overflow-x-auto">
              <table className="border-collapse text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-white/10 px-2 py-0.5 text-left font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-white/10 px-2 py-0.5">{children}</td>
          ),
          hr: () => <hr className="my-2 border-white/10" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
