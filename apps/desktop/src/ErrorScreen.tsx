export interface Failure {
  /** One line, short enough for the strip. */
  summary: string;
  details: string[];
}

export interface ErrorScreenProps {
  failure: Failure;
  expanded: boolean;
  onShowDetails(): void;
}

/**
 * Replaces the diorama when it can't start or keeps running (ADR 0009 §3). The strip only has room
 * for the summary, so its Details button expands the window, which lists every detail.
 */
export function ErrorScreen({ failure, expanded, onShowDetails }: ErrorScreenProps) {
  return (
    <main className="error-screen">
      <h1>
        {failure.summary}
        {!expanded && failure.details.length > 0 && (
          <button type="button" onClick={onShowDetails}>
            Details
          </button>
        )}
      </h1>
      {expanded && (
        <ul>
          {failure.details.map((detail, i) => (
            <li key={i}>{detail}</li>
          ))}
        </ul>
      )}
    </main>
  );
}
