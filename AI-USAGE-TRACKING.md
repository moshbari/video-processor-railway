# AI Usage & Spend Tracking

Answers: **who is using how much AI, and what does it cost?** Covers the two
devrant features that call real AI and cost money:

- **Doc Factory** (`/api/doc-factory`) — Claude passes (subscription CLI, API fallback)
- **Audio Rant** (`/api/audio-reaction/generate-voiceovers`) — OpenAI / ElevenLabs text-to-voice

## How it works

Every AI job is recorded per user (Supabase `X-User-Id`) into R2, mirroring the
Doc Factory library pattern so it survives Railway restarts:

- `ai-usage/users/{userId}.json` — per-user totals + recent events
- `ai-usage/index.json` — light per-user summary for the dashboard

"AI credit" = an estimated USD cost:
- Doc Factory subscription runs use the `claude` CLI's own `total_cost_usd`
  (the API-equivalent price of the run) when present, else estimate from tokens.
- Audio Rant estimates from characters × the provider's TTS rate.
- These are **estimates for visibility, not a bill.**

Rates are overridable via env (`RATE_OPUS_IN`, `RATE_SONNET_OUT`, `RATE_TTS_OPENAI`,
`RATE_TTS_ELEVENLABS`, …). Defaults: Opus 4.8 $5/$25, Sonnet 5 $3/$15,
OpenAI TTS $15/1M chars, ElevenLabs ~$180/1M chars.

## The dashboard

Open in a browser (Railway backend URL, not the Lovable frontend):

    https://<backend-host>/api/admin/ai-usage/dashboard?key=YOUR_ADMIN_KEY

Shows a sortable table: user, email, Doc Factory (runs · $), Audio Rant (runs · $),
total runs, estimated spend, last used — plus grand-total cards.

JSON APIs (same gate):
- `GET /api/admin/ai-usage` — full report
- `GET /api/admin/ai-usage/user/:id` — one user's recent AI jobs

**Set `ADMIN_KEY` in Railway** to lock these down. If `ADMIN_KEY` is unset the
views are open (dev only).

## Frontend (Lovable) — small header additions

The backend attributes usage from request headers. Doc Factory already sends
`X-User-Id`. To make the picture complete, add:

1. **Audio Rant voiceovers** — on the call to
   `POST /api/audio-reaction/generate-voiceovers`, add header
   `X-User-Id: <supabase user id>` (same value already sent to the Clip Library).
   Without it, AI voiceover spend is bucketed under "anonymous".

2. **Friendly names (optional but nice)** — add header
   `X-User-Email: <supabase user email>` to BOTH
   `POST /api/doc-factory/generate` and
   `POST /api/audio-reaction/generate-voiceovers`, so the dashboard shows an
   email next to each user id instead of just the id.

No other frontend changes are needed.
