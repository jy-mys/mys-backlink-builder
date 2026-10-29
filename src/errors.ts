// Errors use the same codes the page's errMsg() and retry logic already understand.
export type ToolErrorCode =
  | 'not_granted'
  | 'tool_error'
  | 'server_unavailable'
  | 'upstream_error'
  | 'server_not_connected'
  | 'rate_limited'
  | 'blocked_by_policy';

export class ToolError extends Error {
  constructor(
    public code: ToolErrorCode,
    message: string,
    public status: number,
    public retryable = false,
    public retryAfterMs?: number,
  ) {
    super(message);
  }

  toJSON() {
    const e: Record<string, unknown> = { code: this.code, message: this.message };
    if (this.retryable) {
      e.retryable = true;
      e.retryAfterMs = this.retryAfterMs ?? 1500;
    } else e.retryable = false;
    return { error: e };
  }
}

export function retryAfter(h: string | null, fallbackMs: number): number {
  const n = h ? parseInt(h, 10) : NaN;
  return isNaN(n) ? fallbackMs : Math.min(Math.max(n * 1000, 500), 30000);
}
