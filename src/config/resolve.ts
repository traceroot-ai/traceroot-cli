/**
 * Resolved authentication details for an API request. Filled in by P2-2.
 */
export interface ResolvedAuth {
  token: string;
  apiUrl: string;
}

/**
 * Placeholder auth resolution (env vars + config file precedence). P2-2.
 */
export function resolveAuth(): ResolvedAuth {
  throw new Error("not implemented");
}
