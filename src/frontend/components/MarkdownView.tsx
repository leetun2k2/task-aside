// Safe React Markdown renderer component (SPECIFICATION.md §2 C-01; PRD §3; RF-14).
// Replaces unsafe regex-based HTML injection with native React Markdown rendering.
// Raw HTML is disabled by default; remote images are rendered as safe placeholders.
import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownViewProps {
  content: string;
  className?: string;
}

export const MarkdownView = memo(function MarkdownView({
  content,
  className = '',
}: MarkdownViewProps) {
  return (
    <div className={`markdown-content ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Remote images are converted into safe placeholders to prevent unsolicited tracking fetches
          img({ src, alt }) {
            return (
              <span className="image-placeholder text-sm text-gray-500 bg-gray-100 px-2 py-0.5 rounded border border-gray-300">
                🖼️ [{alt || 'Image'}] ({src || ''})
              </span>
            );
          },
          // Safe external link rendering; reject dangerous schemes (javascript:, data:)
          a({ href, children }) {
            const isSafe =
              href?.startsWith('http://') || href?.startsWith('https://') || href?.startsWith('#');
            if (!isSafe) {
              return <span>{children}</span>;
            }
            return (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
