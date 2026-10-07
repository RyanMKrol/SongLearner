import { Component, type ErrorInfo, type ReactNode } from 'react'
import { logError } from '../log'

/** Logs rendering crashes and shows a way back instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logError('react', 'render crash', { error, componentStack: info.componentStack?.split('\n').slice(0, 12).join('\n') })
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="landing">
        <div className="landing-card">
          <h1>Something broke</h1>
          <p className="muted">{this.state.error.message}</p>
          <p className="muted small">The details were saved to the logs.</p>
          <button className="btn btn-primary" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </div>
    )
  }
}
