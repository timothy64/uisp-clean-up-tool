# UISP Cleanup Tool

Local web tool to bulk-remove old offline devices **and empty sites** from **UISP 3.0.151** using the official NMS REST API.

## Quick Start

```bash
npm install
npm start
```

Then open **http://localhost:3000** in your browser.

## How It Works

The tool has two independent workflows, selectable via the **Devices** / **Sites** tabs in the header.

### Devices Workflow

1. **Connect** - Enter your UISP base URL, an API token (Admin or Super Admin), and test the connection.
2. **Rules** - Set the offline threshold (e.g. devices offline for >= 90 days), and optionally filter by site, role, model, or name.
3. **Review** - Inspect the candidate list in a searchable table. Select/deselect individual devices, export to CSV.
4. **Execute** - Type a confirmation phrase to unlock deletion. Devices are removed one-by-one via `DELETE /nms/api/v2.1/devices/{id}` with real-time progress streaming. A timestamped log file is saved in `./logs/`.

### Sites Workflow (v1.5)

1. **Connect** - Enter your UISP credentials (synced from the Devices tab if already entered).
2. **Review** - See all sites with **exactly 0 devices assigned** (strict-empty). Search, select, export to CSV.
3. **Execute** - Type `DELETE N SITES` to confirm. Sites are removed one-by-one via `DELETE /nms/api/v2.1/sites/{id}`.

**Strict-empty definition:** A site is eligible for deletion only when the cross-reference of `GET /nms/api/v2.1/devices` shows zero devices referencing that site ID. This is computed server-side every time you load the Sites workflow.

## API Token

Create a token in your UISP instance at **Settings > Users > API Tokens**.

| Action | Minimum Role |
|---|---|
| List devices (dry-run) | Read Only |
| List sites (dry-run) | Read Only |
| Delete devices | Admin or Super Admin |
| Delete sites | Admin or Super Admin |

## Self-Signed Certificates

If your UISP uses a self-signed TLS certificate, check the "Skip TLS certificate verification" box on the Connect screen.

## Safety Features

- **Dry-run by default** - nothing is deleted until you explicitly confirm.
- **Type-to-confirm** - you must type `DELETE N DEVICES` or `DELETE N SITES` exactly.
- **Rate limiting** - 250ms delay between each delete call.
- **Audit logs** - every deletion attempt is logged to `./logs/` as JSONL with timestamps, device IDs, and API responses.
- **Token stays in memory** - the API token is never written to disk (redacted in all logs).

## Environment Variables (optional)

Copy `.env.example` to `.env` to pre-fill defaults. The GUI always takes precedence.

| Variable | Description |
|---|---|
| `PORT` | Local server port (default `3000`) |

## Requirements

- Node.js 18+
- Network access to your UISP instance

---

## Logging

All structured logs are written to `./logs/` as JSONL (one JSON object per line).

### Log files

| File pattern | Contents |
|---|---|
| `app-<timestamp>.jsonl` | Application lifecycle: route start/end, UISP request/response metadata, retries, errors |
| `delete-<timestamp>.jsonl` | Per-device deletion results for a single batch job |
| `site-delete-<timestamp>.jsonl` | Per-site deletion results for a single batch job |

### Log schema

Every log line includes a `timestamp` (ISO 8601) and an `event` field. Common fields:

| Field | Description |
|---|---|
| `timestamp` | ISO 8601 UTC time |
| `event` | Event type (see below) |
| `requestId` | UUID correlating all log entries for a single API call |
| `route` | Local API route (e.g. `/api/connect/test`) |
| `method` | HTTP method sent to UISP |
| `url` | Full URL called on UISP |
| `attempt` | Retry attempt number (1-based) |
| `status` | UISP HTTP response status |
| `durationMs` | Round-trip time for the UISP call |
| `errorCode` | Machine-readable error classification |
| `deviceId` | Device UUID (in device delete operations) |
| `siteId` | Site UUID (in site delete operations) |
| `ok` | Boolean success indicator |

### Event types

| Event | When |
|---|---|
| `server_start` | App starts listening |
| `route_start` | Incoming request begins processing |
| `route_end` | Incoming request completes (success or error) |
| `uisp_response` | Got a response from UISP |
| `uisp_redirect` | Following an HTTP redirect from UISP |
| `uisp_retry` | Retrying a transient failure |
| `uisp_error` | Network/TLS error talking to UISP |
| `delete_job_start` | Batch device delete job begins |
| `delete_item` | Single device delete result |
| `delete_job_end` | Batch device delete job completes with summary |
| `site_delete_job_start` | Batch site delete job begins |
| `site_delete_item` | Single site delete result |
| `site_delete_job_end` | Batch site delete job completes with summary |

### Token redaction

API tokens are **never** written in full to any log. They appear as `abcd...wxyz` (first 4 + last 4 characters only).

---

## Error Handling

### Error response format

All backend API errors return a consistent JSON envelope:

```json
{
  "ok": false,
  "errorCode": "DNS_FAILURE",
  "message": "DNS lookup failed for host: uisp.example.com"
}
```

### Error codes reference

| Error Code | HTTP | Meaning | Fix |
|---|---|---|---|
| `VALIDATION` | 400 | Missing required fields in request | Fill in both the UISP URL and API token |
| `DNS_FAILURE` | 502 | Cannot resolve UISP hostname | Check the URL spelling and DNS |
| `CONN_REFUSED` | 502 | UISP host reachable but port closed | Verify UISP is running and the port is correct |
| `CONN_RESET` | 502 | Connection dropped mid-request | Transient; retried automatically up to 3 times |
| `TIMEOUT` | 502 | No response within 15 seconds | Check network path; UISP may be overloaded |
| `TLS_CERT` | 502 | Self-signed or invalid certificate | Enable "Skip TLS verification" checkbox |
| `TLS_ERROR` | 502 | TLS handshake failed | Check UISP TLS config or enable skip |
| `REDIRECT_LIMIT` | 502 | More than 5 redirects | Verify the base URL is the final canonical URL |
| `REDIRECT_NO_LOCATION` | 502 | Redirect missing Location header | Unusual; check UISP reverse proxy config |
| `UISP_UNAUTHORIZED` | 401 | Token invalid or expired | Regenerate the API token in UISP |
| `UISP_FORBIDDEN` | 403 | Token lacks permissions | Use an Admin or Super Admin token |
| `UISP_NOT_FOUND` | 502 | API path does not exist | Confirm UISP version supports `/nms/api/v2.1` |
| `UISP_BAD_REQUEST` | 502 | UISP rejected the request | Check API docs for parameter requirements |
| `UISP_VALIDATION` | 502 | UISP schema validation failed | Check request body/parameters |
| `UISP_SERVER_ERROR` | 502 | UISP 5xx internal error | Transient; retried automatically |
| `NETWORK_ERROR` | 502 | Unclassified network failure | Check connectivity and firewall rules |

### Retry behavior

- **Retried automatically (up to 3 attempts):** 429, 502, 503, 504, and network errors (ECONNRESET, ECONNREFUSED, ETIMEDOUT, EPIPE, EAI_AGAIN).
- **Never retried:** 400, 401, 403, 404, 422 (these require user action).
- **Backoff:** Exponential — 500ms, 1000ms, 2000ms between attempts.
- **Timeout:** Each individual request times out after 15 seconds.

### Redirect handling

HTTP 301/302/307/308 responses are followed automatically up to 5 hops. The original method, headers, and auth token are preserved across redirects. Each redirect is logged.

---

## Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| "UISP responded with status 301" | URL redirecting (http->https, trailing slash) | Use the canonical HTTPS URL from your browser |
| "DNS lookup failed" | Wrong hostname | Double-check the URL |
| "TLS certificate rejected" | Self-signed cert | Check the "Skip TLS" box |
| "Invalid or expired API token" | Bad token | Regenerate in UISP Settings > Users |
| "Token lacks required permissions" | Read-only token used for delete | Create an Admin/Super Admin token |
| Deletions partially fail | Mixed device states | Check the delete log for per-device error codes |
| Site deletion fails with 403 | Insufficient permissions | Use an Admin or Super Admin token |
| No empty sites found | All sites have devices | All sites have at least 1 device assigned |
| Site shows 0 devices but UISP shows devices | Stale data | Reload the Sites workflow to re-fetch fresh data |
| App won't start | Port in use | Change `PORT` in `.env` or stop the other process |
