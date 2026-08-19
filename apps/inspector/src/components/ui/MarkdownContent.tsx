import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function SafeLink({ href, children, ...props }: ComponentPropsWithoutRef<"a">) {
  if (!href) return <span>{children}</span>;
  let safeHref: string | undefined;
  try {
    const url = new URL(href, window.location.href);
    if (url.protocol === "http:" || url.protocol === "https:") safeHref = url.href;
  } catch {
    safeHref = undefined;
  }
  if (!safeHref) return <span>{children}</span>;
  return (
    <a {...props} href={safeHref} rel="noreferrer" target="_blank">
      {children}
    </a>
  );
}

/** Renders untrusted Session content without raw HTML or remote image loading. */
export function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown
        components={{
          a: SafeLink,
          img: ({ alt }) => (
            <span className="markdown-content__image">[image: {alt ?? "untitled"}]</span>
          ),
        }}
        remarkPlugins={[remarkGfm]}
        skipHtml
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
