import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Banner, Button } from '@acc/ui';
import { isChunkLoadError } from './reload';

/**
 * Keeps one page's failure inside the page: the Shell, navigation and banners stay usable.
 * A route chunk that no longer exists (a release happened while the page was open) is
 * named as a new version rather than as an error.
 */
export class PageErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  override state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.warn('Page failed to render', error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (error === null) return this.props.children;
    const newVersion = isChunkLoadError(error);
    return (
      <div className="px-4 pt-6 sm:px-5 md:px-6 xl:px-8">
        <Banner
          tone={newVersion ? 'info' : 'danger'}
          role="alert"
          title={newVersion ? 'A new version is available.' : 'This page could not be shown.'}
          actions={<Button size="compact" variant="primary" onClick={() => window.location.reload()}>Reload</Button>}
        >
          {newVersion ? 'The Control Center was updated while this page was open. Reload to continue.' : 'Reload the page. If it happens again, the details are in the browser console.'}
        </Banner>
      </div>
    );
  }
}
