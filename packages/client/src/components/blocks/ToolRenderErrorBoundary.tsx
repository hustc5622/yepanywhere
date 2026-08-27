import { Component, type ErrorInfo, type ReactNode } from "react";
import { useOptionalI18n } from "../../i18n";

interface Props {
  toolId: string;
  toolName: string;
  status: string;
  input: unknown;
  result: unknown;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

function ToolRenderFallback({
  toolName,
  status,
}: {
  toolName: string;
  status: string;
}) {
  const i18n = useOptionalI18n();
  return (
    <div className={`tool-row timeline-item status-${status}`}>
      <div className="tool-row-header" role="status">
        <span className="tool-name">{toolName}</span>
        <span className="tool-summary">
          {i18n
            ? i18n.t("toolRendererUnavailable")
            : "Tool details are temporarily unavailable"}
        </span>
      </div>
    </div>
  );
}

export class ToolRenderErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, _errorInfo: ErrorInfo) {
    console.error("Tool renderer failed", {
      toolName: this.props.toolName,
      status: this.props.status,
      errorName: error.name,
    });
  }

  componentDidUpdate(previous: Props) {
    if (
      this.state.error &&
      (previous.toolId !== this.props.toolId ||
        previous.toolName !== this.props.toolName ||
        previous.status !== this.props.status ||
        previous.input !== this.props.input ||
        previous.result !== this.props.result)
    ) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <ToolRenderFallback
          toolName={this.props.toolName}
          status={this.props.status}
        />
      );
    }
    return this.props.children;
  }
}
