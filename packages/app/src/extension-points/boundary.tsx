import { Component, type ReactNode } from "react";
import { extensionRegistry } from "./registry";

interface LayerBoundaryProps {
  owner: string;
  point: string;
  /** Rendered once the layer throws; the next layer in, or nothing. */
  fallback: ReactNode;
  children?: ReactNode;
}

/**
 * One plugin layer's error boundary. A throw falls back to the layer inside it and records the
 * error against the plugin. A new layer gets a new key, which resets the boundary.
 */
export class LayerBoundary extends Component<LayerBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.warn(`[Plugins] ${this.props.owner} failed at ${this.props.point}`, error);
    extensionRegistry.reportError(this.props.owner, this.props.point, error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
