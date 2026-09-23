import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@acc/ui';

/**
 * Artifacts render inside a page that already has an h1 and panel h2s, so
 * their headings are demoted to keep one logical outline (WCAG 1.3.1).
 */
const HEADINGS: Components = {
  h1: ({ node: _n, ...props }) => <h3 data-md="h1" {...props} />,
  h2: ({ node: _n, ...props }) => <h4 data-md="h2" {...props} />,
  h3: ({ node: _n, ...props }) => <h5 data-md="h3" {...props} />,
  h4: ({ node: _n, ...props }) => <h6 {...props} />,
  h5: ({ node: _n, ...props }) => <h6 {...props} />,
};

/**
 * Renders agent-produced Markdown (plans, reviews, reports). Raw HTML is not
 * rendered, so artifact content cannot inject markup or scripts.
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div
      className={cn(
        'min-w-0 text-body text-fg wrap-anywhere',
        '[&_[data-md=h1]]:mb-2 [&_[data-md=h1]]:mt-4 [&_[data-md=h1]]:text-h2 [&_[data-md=h2]]:mb-2 [&_[data-md=h2]]:mt-4 [&_[data-md=h2]]:text-h3 [&_[data-md=h3]]:mb-1 [&_[data-md=h3]]:mt-3 [&_[data-md=h3]]:font-semibold [&_h6]:mt-2 [&_h6]:font-semibold',
        '[&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5',
        '[&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-code',
        '[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border-subtle [&_pre]:bg-canvas [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0',
        '[&_a]:text-fg [&_a]:underline [&_a]:underline-offset-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border-strong [&_blockquote]:pl-3 [&_blockquote]:text-fg-secondary',
        '[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border-subtle [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border-subtle [&_th]:px-2 [&_th]:py-1 [&_th]:text-left',
        '[&>*:first-child]:mt-0',
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={HEADINGS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
