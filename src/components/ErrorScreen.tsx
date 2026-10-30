import { Component, type ReactNode } from 'react';
import { Button } from './ui/button';

/**
 * Catches an error that would otherwise unmount the whole app and leave a
 * blank page, and offers a reload instead.
 */
export class ErrorScreen extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" className="grid min-h-screen place-items-center p-4">
        <div className="max-w-md text-center">
          <img src="/logo.svg" alt="" width={56} height={56} className="mx-auto" />
          <p className="mt-3 font-medium">Something went wrong loading Wattle.</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{error.message}</p>
          <Button className="mt-4" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      </div>
    );
  }
}
