# SerpApi backup setup

Keep the existing private `.env`. At the top, paste the key after `SERPAPI_API_KEY=` and save the file. Do not add spaces inside the key or put it in browser assets, screenshots or chat.

```dotenv
SERP_PROVIDER=searxng
GOOGLE_BACKUP_PROVIDER=serpapi
SERPAPI_API_KEY=
GOOGLE_BACKUP_DAILY_LIMIT=50
GOOGLE_BACKUP_COST_PER_1K=
```

SearXNG remains primary. If a query returns no usable regular Google listings, one SerpApi Google request can supplement the primary results. A backup failure preserves the primary listings. Explicit failures never cause another attempt against the same failed service. Each provider call is counted separately. The daily backup cap includes public and operator calls and resets at midnight UTC; adjust it to fit your account. A blank cost estimate means unknown, not free.

Restart the local preview after changing `.env`, using `npm run dev:live` after stopping the previous preview. The key stays on the server; `/api/config` exposes only the provider name and readiness. `.env` is ignored by Git.

Start a new scan and accept the updated consent naming SearXNG and SerpApi. Older saved scans retain their original consent and results. Reports distinguish Google via SerpApi from SearXNG engine results, and retained findings from earlier scans remain labeled as earlier observations.

The backup requests fresh Google web results with documented page offsets. It does not guarantee the same results as your Google.com session or exhaustive coverage. See [SerpApi's search API documentation](https://serpapi.com/search-api). No source pages, images or media are fetched by this workflow.
