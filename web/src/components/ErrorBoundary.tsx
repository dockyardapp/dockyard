import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Button, EmptyState } from './ui';

type Props = {
  children: ReactNode;
  /** What stopped, so the message names the surface rather than saying "something". */
  title?: string;
};

type State = { error: Error | null };

/**
 * Keeps a render crash inside one surface.
 *
 * Without a boundary a throw anywhere in the tree unmounts everything React rendered: no nav, no
 * account block, no way back except reloading the tab by hand. That is the worst possible outcome
 * for a console that is the only route to the host, so every crash lands here instead.
 *
 * Mounted twice: around the routed page inside the shell, so a broken view keeps its nav and the
 * operator can click away from it, and around the whole app, so a crash in the shell itself still
 * says something rather than showing a blank page.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // A boundary swallows the throw, so put it where a developer can still find it, with the
    // component stack attached.
    console.error('[dockyard] a view crashed', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <EmptyState
        icon="warning"
        title={this.props.title ?? 'This view stopped responding'}
        action={<Button onClick={() => window.location.reload()}>Reload the panel</Button>}
      >
        <p>Something in this view threw while rendering. The rest of the panel is still running.</p>
        <p className="mono">{error.message}</p>
      </EmptyState>
    );
  }
}
