# Web Tools

## Tools
- `web_search`: web search via SerpAPI, then Brave, then DuckDuckGo fallback
- `web_fetch`: fetch + extract content with Readability

## Safety
- URL allowlist and SSRF protection
- Response size caps

## Usage
Use for research and to validate claims or catalysts.

## Proactive Loop Integration
- Proactive search now runs multi-round web research:
  - seed queries (watchlist, recent intel, learned queries)
  - run `web_search` and optional `web_fetch`
  - persist findings to intel memory
  - optionally generate follow-up queries from evidence
- Query outcomes are tracked in SQLite (`proactive_query_stats`) to rank future query seeds.
