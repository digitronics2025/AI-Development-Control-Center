import { CheckCircle2, Info, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from '../lib/cn.js';

interface ToastItem {
  id: number;
  message: string;
  tone: 'success' | 'info';
}

interface FeedbackApi {
  /** Transient confirmation of a low-risk outcome: saved, copied, queued (design.md §8.6). */
  toast: (message: string, tone?: ToastItem['tone']) => void;
  /** Screen-reader announcement for meaningful status changes (design.md §11). */
  announce: (message: string) => void;
}

const FeedbackContext = createContext<FeedbackApi | null>(null);

export function useFeedback(): FeedbackApi {
  const api = useContext(FeedbackContext);
  if (!api) throw new Error('useFeedback must be used inside <FeedbackProvider>');
  return api;
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [announcement, setAnnouncement] = useState('');
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  const toast = useCallback(
    (message: string, tone: ToastItem['tone'] = 'success') => {
      const id = nextId.current++;
      setToasts((all) => [...all.slice(-3), { id, message, tone }]);
      window.setTimeout(() => dismiss(id), 4000);
    },
    [dismiss],
  );
  const announce = useCallback((message: string) => {
    // Clear first so repeating the same text is announced again.
    setAnnouncement('');
    window.setTimeout(() => setAnnouncement(message), 50);
  }, []);
  const api = useMemo(() => ({ toast, announce }), [toast, announce]);

  return (
    <FeedbackContext.Provider value={api}>
      {children}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>
      <div role="status" aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(360px,calc(100vw-32px))] flex-col gap-2">
        {toasts.map((t) => (
          <Toast key={t.id} item={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </FeedbackContext.Provider>
  );
}

function Toast({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const Icon = item.tone === 'success' ? CheckCircle2 : Info;
  return (
    <div
      className={cn(
        'pointer-events-auto flex items-start gap-2 rounded-lg border border-border-subtle bg-elevated px-3 py-2.5 shadow-float transition-[opacity,transform] duration-[160ms] ease-out',
        visible ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0',
      )}
    >
      <Icon size={16} className={cn('mt-0.5 shrink-0', item.tone === 'success' ? 'text-success' : 'text-info')} aria-hidden />
      <p className="min-w-0 flex-1 text-body text-fg">{item.message}</p>
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="rounded-sm text-fg-secondary hover:text-fg focus-visible:outline-2 focus-visible:outline-focus">
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}
