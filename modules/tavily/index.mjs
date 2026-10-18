// Tavily web search, a ToolModule (docs/plans/extension-modules.md R24; docs/architecture/modules-tavily.md). Plain
// JavaScript with no dependency (R23, R37): Node's fetch, which the module base sends through the egress proxy
// (NODE_USE_ENV_PROXY=1, R6 (b)). One tool, `search`, at Tavily's basic search depth, asking for its credit usage so the
// harness can settle its meter (R18b). Facts read 2026-10-01 from docs.tavily.com/documentation/api-reference/endpoint/search:
// POST https://api.tavily.com/search, `Authorization: Bearer <key>`, `search_depth` (default "basic"), `max_results`
// (default 10), `include_usage` (default false) adding `usage` with the request's credits.

const ENDPOINT = 'https://api.tavily.com/search';
/** Bound on Tavily's answer: inside the tool's 30 s, so the module answers before the harness's bound. */
const REQUEST_MS = 25_000;

/** What reaches the model from each result: its title, URL and content, never raw_content (a whole page). */
function result(r) {
  return { title: String(r.title ?? ''), url: String(r.url ?? ''), content: String(r.content ?? '') };
}

export async function call(tool, args, context) {
  if (tool !== 'search') return { ok: false, reason: 'unknown_tool', detail: `no tool ${tool}` };
  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${context.secrets.TAVILY_API_KEY}` },
      body: JSON.stringify({
        query: args.query,
        search_depth: 'basic',
        max_results: args.max_results ?? 5,
        include_usage: true,
      }),
      signal: AbortSignal.timeout(REQUEST_MS),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
    return {
      ok: false,
      reason: timedOut ? 'timeout' : 'module_unavailable',
      detail: timedOut
        ? `Tavily did not answer within ${REQUEST_MS} ms`
        : `Tavily could not be reached: ${error.message}`,
    };
  }
  if (!response.ok)
    return { ok: false, reason: 'module_unavailable', detail: `Tavily answered HTTP ${response.status}` };
  let body;
  try {
    body = await response.json();
  } catch (error) {
    return { ok: false, reason: 'module_unavailable', detail: `Tavily's answer is not JSON: ${error.message}` };
  }
  const credits = body?.usage?.credits;
  return {
    ok: true,
    result: {
      query: String(body?.query ?? args.query),
      results: Array.isArray(body?.results) ? body.results.map(result) : [],
    },
    ...(typeof credits === 'number' ? { usage: { units: credits } } : {}),
  };
}
