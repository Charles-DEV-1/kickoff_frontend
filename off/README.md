# Kickoff frontend

A small, framework-free multi-page frontend built with HTML, CSS, and vanilla ES modules. The requested screens are separate HTML files and share one accessible, responsive design system and local-storage state module.

## Open the app

Serve this folder over HTTP so browsers can load the ES module:

```powershell
cd path\to\kickoff-app
python -m http.server 8000
```

Then open `http://localhost:8000/`. Stop the server with Ctrl+C.

## Included flows

- Onboarding name and language setup, with email-link sign-in required before private app screens
- AI, manual, and server-template task creation with editable notes, due dates, and step plans
- Three step-size presets, edit/reorder/delete/undo, and 1–240 minute steps
- Persistent focus timer, five-minute extension, neutral time-up screen, and completion rewards
- Points, plant growth, streaks, and a returning-user freeze view
- Comfort/profile settings, reminder preferences, data export, account deletion, and local-data clearing
- Sticky Home / Tasks / Progress / Settings navigation on the main views

## Storage and scope

Private app screens require a Supabase email-link session and use the Kickoff API. The `kickoff.v1` localStorage entry keeps interface preferences and a short account deletion receipt; authenticated task data is refreshed from the API. Reminder enablement, daily cap, and quiet-hour boundaries sync to supported profile settings. Chosen weekdays and reminder time remain local, and automatic reminder delivery is unavailable because the API does not provide a delivery service.

The workspace had no separate app-screen reference images, so the visual design follows the screen list and interaction requirements provided with the request and FRD.

## Backend-connected build

This version includes Supabase email-link authentication and connects the supported AI/task flows to the deployed Kickoff API.

### Configuration

`config.js` contains the Supabase project URL, Supabase publishable key, and API origin supplied for this integration. The publishable key is designed for browser use; never add a Supabase secret/service-role key, Groq key, database password, or cron secret here.

### First-time deployment checks

1. In Supabase Authentication settings, enable email sign-in/OTP and add the exact deployed frontend URL (and its `/account-sync.html` redirect) to the allowed redirect URLs.
2. Ask the backend developer to add the exact deployed frontend origin to the Flask API `ALLOWED_ORIGINS` setting. The origin must match scheme, host, and port.
3. Serve this folder over HTTP/HTTPS; do not open the HTML files directly with `file://`.
4. Open Settings → Account & sync, enter your email, and follow the sign-in link.
5. Create a task. Kickoff calls `POST /v1/ai/breakdown`, lets you review/edit the suggested steps, and only then saves it with `POST /v1/tasks`.

### Connected API behavior

- Supabase Auth issues the access token; protected Flask requests use `Authorization: Bearer`.
- Signed-in startup loads `/v1/bootstrap` and uses its ETag for revalidation.
- AI suggestions are not assumed to be AI every time: the interface reports the backend's actual `source` (`ai` or `template`).
- Task creation uses a fresh `Idempotency-Key`.
- Starting and completing a cloud step call the documented step-action endpoints with the current version.
- Existing local task data can be reviewed and explicitly imported; it is never uploaded automatically.

### Current scope and known limits

The frontend uses documented endpoints for profile reads and updates, bootstrap/ETag caching, task list and delta pagination, task detail and CRUD, step CRUD/reordering/start/complete/reopen, AI breakdown, template manifest/list/detail, health/readiness, data export, and account deletion. Writes use server versions and retry-safe idempotency keys. Reminder delivery, analytics, routines, and offline write replay are outside this backend contract; reminder timing/day choices remain local. Added template, service-status, deletion-confirmation, and deleted-account screens use the current brand colors, inline SVG illustrations, and reduced-motion-aware feedback.
