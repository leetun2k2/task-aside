// Safe Markdown renderer component (SPECIFICATION.md §2 C-01; PRD §3).
import { marked } from 'marked';
import { useMemo } from 'react';

interface MarkdownViewProps {
  content: string;
  className?: string;
}

function sanitizeHtml(html: string): string {
  let clean = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  clean = clean.replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '');
  clean = clean.replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '');
  clean = clean.replace(/<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi, '');
  clean = clean.replace(/\son\w+="[^"]*"/gi, '');
  clean = clean.replace(/\son\w+='[^']*'/gi, '');
  clean = clean.replace(/href="javascript:[^"]*"/gi, 'href="#"');
  return clean;
}

export function MarkdownView({ content, className = '' }: MarkdownViewProps) {
  const renderedHtml = useMemo(() => {
    try {
      const rawHtml = marked.parse(content, {
        gfm: true,
        breaks: true,
      }) as string;
      return sanitizeHtml(rawHtml);
    } catch {
      // Fallback to text if parsing fails
      return content.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
  }, [content]);

  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized markdown
    <div className={`markdown-content ${className}`} dangerouslySetInnerHTML={{ __html: renderedHtml }} />
  );
}
