/** A recorded fetch invocation. */
export interface FetchCall {
  url: string;
  init: RequestInit;
}

/** A fake fetch and the list of calls it has recorded. */
export interface FakeFetch {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
}

/** Builds a JSON {@link Response} with the given body and status. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Builds a JSON error {@link Response} carrying a `detail` string. */
export function errorResponse(status: number, detail: string): Response {
  return jsonResponse({ detail }, status);
}

/**
 * Creates a fake fetch that records every call and returns whatever the
 * `responder` produces for that call. The responder may return a `Response`
 * directly or throw/reject to simulate a network failure.
 */
export function createFakeFetch(
  responder: (call: FetchCall) => Response | Promise<Response>,
): FakeFetch {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const call: FetchCall = { url, init: init ?? {} };
    calls.push(call);
    return await responder(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}
