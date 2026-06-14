import { Component, type ReactNode } from 'react'

/**
 * App-root error boundary: a render fault anywhere must never leave a blank white
 * screen. Shows the real error + a reload, instead of silently unmounting the app.
 */
export class AppErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error) {
    // eslint-disable-next-line no-console
    console.error('App render error:', error)
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex h-screen w-screen flex-col items-center justify-center gap-3 bg-slate-950 p-6 text-center">
          <p className="text-lg font-semibold text-red-300">Something went wrong</p>
          <p className="max-w-lg break-words text-xs text-red-400/80">{this.state.error.message}</p>
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => this.setState({ error: null })}
              className="rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700"
            >
              Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
            >
              Reload
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
