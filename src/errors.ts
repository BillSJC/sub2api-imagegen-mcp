export class SafeError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SafeError";
    this.code = code;
  }
}

export function publicErrorMessage(error: unknown): string {
  if (error instanceof SafeError) {
    return `${error.code}: ${error.message}`;
  }
  return "internal_error: The MCP server failed without exposing sensitive details.";
}
