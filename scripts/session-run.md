# Browser session-import developer guide

Session mode accepts text result batches into the browser service. Old HTTP `/api/scan/:id/queries` and `/import` endpoints return 410. Do not use curl, database exports or a user's existing IDs for this workflow.

There is no public upload/import control yet. This is a **developer-only synthetic check**, creating a fresh fixture in an isolated browser profile. A user-facing import feature needs its own reviewed UI/consent flow. Do not extract existing user records through DevTools or copy them into search/AI tools.

## Start a synthetic session preview

Use a separate browser profile and port. Preserve existing secret files; these process flags select session mode with relay/cloud AI off.

```sh
npm install
npm run build:browser
npx wrangler dev --local --port 8788 --persist-to .wrangler/session-fixtures --var SERP_PROVIDER:session --var ALLOW_SEARCH_RELAY:false --var CLOUD_AI_ENABLED:false
```

Open `http://localhost:8788`. Ordinary intake may show search unavailable while the relay is off; do not enable it for this test. In DevTools, call the local service to create only a new synthetic scan:

```js
const { localApi } = await import('/local-api.js');
const created = await localApi('/api/scan', {
  method: 'POST',
  body: {
    full_name: 'Synthetic Fixture', subject_type: 'person',
    attestation: true, is_minor: false,
    harm_types: ['scam_fraud'], context: { country_code: '' },
  },
});
const fixturePath = `/api/scan/${created.id}`;
await localApi(fixturePath); // Prepare this new fixture's local queries.
const pending = await localApi(`${fixturePath}/queries`);
```

`localApi` is an in-browser function; those strings do not send records to HTTP routes. Configuration may be fetched, but session imports/processes make no search, source-page, RDAP or AI calls.

## Import a fixture batch

The contract is `{results:[{q,items:[{title,url,snippet}]}]}`. Each query must exactly match a pending query in this fixture. Limits are 20 queries per call and 20 items per query. Empty items mark a completed query with no results. Never invent real findings; this example is explicitly fictional:

```js
await localApi(`${fixturePath}/import`, {
  method: 'POST',
  body: { results: pending.queries.slice(0, 20).map(({ q }, index) => ({
    q,
    items: index === 0 ? [{
      title: 'Synthetic Fixture — fictional complaint',
      url: 'https://publisher.example/fixture',
      snippet: 'A fictional complaint about Synthetic Fixture. Not a real allegation.',
    }] : [],
  })) },
});
const fixtureReport = await localApi(fixturePath);
```

The report stays `awaiting_import` while pending queries remain. Repeat using only this new fixture's pending queries until complete. Filtering/domain caps can exclude items. Inspect it at `/report.html#id=<new-fixture-id>` if needed. Never send assistance/removal requests from fixtures.

Delete this fixture after checking:

```js
await localApi(fixturePath, { method: 'DELETE' });
```

Deletion is local; it does not clean up external files or third-party searches. There is no sanctioned operator export of user records. A future real session-search workflow needs explicit permission for the external provider and must not search intimate imagery, download media or use AI on the person's records.

Run `npm test -- --no-cache` for mocked browser-service/session-import coverage. See [README.md](../README.md) and [PLAN.md](../PLAN.md) for the active privacy boundary.
