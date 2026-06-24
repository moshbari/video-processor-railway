# Doc Factory — Lovable frontend checklist (devrant)

Add a new **Doc Factory** tool/tab to the RANT Squad app. It turns one keyword
into a faceless "doodle documentary" video (script → images → voiceover → MP4).

**Backend base URL (staging):** `https://video-processor-staging.up.railway.app`
All endpoints are under `/api/doc-factory`.

---

## 1. New "Doc Factory" page/tab
- [ ] Add a nav entry "Doc Factory 🎬" alongside the other tools.
- [ ] Page has 4 steps shown as a progress bar: **Idea → Script → Images → Video**.

## 2. Step 1 — Idea
- [ ] A big text input: "Your idea or keyword" (placeholder: e.g. *what did ancient humans do at night*).
- [ ] A length selector (3 / 5 / 8 / 10 minutes), default 8.
- [ ] "Generate Script" button → `POST /api/doc-factory/generate` with JSON `{ idea, minutes }`.
  - Response: `{ success, jobId }`.
- [ ] After it returns a `jobId`, poll `GET /api/doc-factory/job/{jobId}?after={cursor}` every ~1.5s.
  - Response: `{ status, nextCursor, events[], result, error }`.
  - Use `nextCursor` as the next `after`. Append each `event` to a live "agent activity" feed.
  - Event shapes: `{type:'phase', key:'blueprint'|'scripting'|'polish'|'done'}`, `{type:'activity', icon, text}`, `{type:'error', text}`.
  - Stop when `status === 'done'` (use `result`) or `'error'` (show `error`).

## 3. Step 2 — Script review
- [ ] Show `result.title` big, with `result.alt_titles[]` as clickable alternates.
- [ ] Show `result.thumbnail_idea` and `result.stats` (panels, words, est_minutes).
- [ ] Show the panel table from `result.panels[]`: each `{ n, narration, panelType, callout, bg }`.
  - text-card panels: show the bold `callout`.
  - illustration panels: show `narration` + the doodle prompt.
- [ ] "Looks good → Images" button advances to Step 3. Keep `result.id` (the project id) for all later calls.

## 4. Step 3 — Images (two ways, like Book Factory)
- [ ] "Make text-cards" button → `POST /api/doc-factory/project/{id}/text-cards` (free, instant). Returns counts.
- [ ] **Manual path (default):**
  - [ ] "Copy prompt sheet" button → `GET /api/doc-factory/project/{id}/prompt-sheet` (text/plain). Copy to clipboard so the user generates images in ChatGPT.
  - [ ] An upload grid, one slot per illustration panel (numbered). Multi-file upload →
        `POST /api/doc-factory/project/{id}/images` as **multipart/form-data**, where **each file's field name is the panel number** (e.g. field `12` = image for panel 12).
  - [ ] Response `{ filled[], pending[] }` — mark filled slots, show how many `pending`.
- [ ] **API path (optional toggle "Auto-generate images"):**
  - [ ] → `POST /api/doc-factory/project/{id}/generate-images` with `{ mode: 'api' }`. Returns `{ generated, pending }`.
- [ ] Show a per-panel preview grid (panel `image` URLs come back on the project: `GET /api/doc-factory/project/{id}`).

## 5. Step 4 — Video
- [ ] Voice picker (optional): provider (OpenAI / ElevenLabs / Speechmatics) + voice. Default OpenAI.
- [ ] "Render Video" button → `POST /api/doc-factory/project/{id}/render` with `{ provider, voice, bgmUrl? }`.
  - Response `{ renderId }`.
- [ ] Poll `GET /api/doc-factory/render/{renderId}?after={cursor}` every ~3s.
  - `{ status, nextCursor, events[], video, error }`. Show panel-by-panel progress from `events`.
  - On `status==='done'`: `video = { url, durationSec, panels }`. Show a player + a **Download** button pointing at `video.url` (a public R2 MP4).

## 6. Notes for Lovable
- [ ] All POST bodies are JSON except the image upload (multipart/form-data).
- [ ] Long operations are background jobs — always poll, never block on the POST.
- [ ] The project persists server-side (R2), so the page can be reopened with the project id.
- [ ] Match the existing dark blue/black RANT Squad theme; make the agent-activity feed feel animated/"agentic".
