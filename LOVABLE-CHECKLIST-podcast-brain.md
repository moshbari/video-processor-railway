# Lovable checklist — Podcast Brain in the PodCast Builder

Paste this whole file into Lovable.

## What already works without you

The backend now fills in a podcast project by itself. When Mosh uploads a video
from tellatotube with **"Also send to the Podcast Editor"** ticked, and YouTube
finishes making the captions, the backend writes four things onto the saved
project:

| What | Where it already goes |
|---|---|
| 18–32 hooks | the existing hooks queue — **nothing to build** |
| The cuts | the existing Danger Zone list — **nothing to build** |
| The Facebook post | a new `socialPost` field — **needs a box** |
| The full report | a new `brainReport` field — **needs a panel** |

`POST /api/manual-clip/restore/:jobId` already returns all four. The hooks and
cuts flow into the existing lists with no change. The two new fields are what
this checklist is about.

---

## 1. Read the two new fields

`POST /api/manual-clip/restore/:jobId` now returns two extra keys alongside
`hooks`, `cuts` and the rest:

```json
{
  "socialPost": "…the Facebook post, usually Bengali, around 3,000 words…",
  "brainReport": "…markdown: hooks table, cold open, bench, moment map…"
}
```

- [ ] In `useManualClipMaker.ts`, where the restore response is unpacked, also
      read `socialPost` and `brainReport` into state.
- [ ] Both are plain strings and both can be `""`. Empty means this episode has
      not been analysed — show nothing at all, not an empty box.

---

## 2. The Facebook post box

Sits beside the player, under the video controls.

- [ ] Only render when `socialPost` is a non-empty string.
- [ ] Heading: **📣 Facebook post** with a **Copy** button.
- [ ] The Copy button copies the *whole* string, unmodified.
- [ ] Render inside a scrollable box, roughly 400px tall, `overflow-y: auto`.
- [ ] **Preserve line breaks** — `white-space: pre-wrap`. The post is built out
      of numbered movements separated by blank lines and `---` rules. Collapsing
      the whitespace destroys it.
- [ ] **It is mostly Bengali.** Use a font stack that renders Bengali properly
      and set `lang="bn"` on the container. Give it a comfortable
      `line-height` (1.7 or so) — Bengali is much harder to read when cramped.
- [ ] Do not truncate it with a "read more". He copies the whole thing.
- [ ] Do not add a character or word counter.

---

## 3. The Podcast Brain report panel

Everything the analysis found that is not a hook or a cut.

- [ ] Only render when `brainReport` is a non-empty string.
- [ ] A **collapsible** panel titled **🎙️ Podcast Brain report**, collapsed by
      default. It is long.
- [ ] Render it as **markdown**. It contains headings, tables, blockquotes and
      fenced code blocks. If there is no markdown renderer in the app already,
      a plain `<pre style="white-space: pre-wrap">` is an acceptable fallback —
      do NOT install a new library just for this.
- [ ] Tables must scroll horizontally on their own (`overflow-x: auto`) rather
      than making the page scroll sideways.
- [ ] Read-only. No editing, no saving.

What is inside it, so you know what you are styling: the cold-open running order
in a code block, the full hooks table, a bench of spare hooks, "use with care"
warnings, the cut list, a moment map, and — when something went wrong — a list
of which passes failed.

---

## 4. The status chip

While an episode is being analysed, the editor should say so. A run takes up to
twenty minutes.

- [ ] Poll `GET /api/manual-clip/podcast-auto/:jobId/status?after=N` while a
      project is open **and** the last response had `status === "running"`.
- [ ] `after` is a cursor: send back the `nextCursor` you got last time, and you
      only receive new events. Start at `0`.
- [ ] Poll every 5 seconds. Stop as soon as `status` is `complete` or `error`.
      Stop when the project is closed.
- [ ] Show a small chip near the project title:
  - `running` → **🎙️ Analysing the episode…** plus the `message` of the newest
    event (they read like "Working on: hooks", "Finished cuts (94s)").
  - `complete` → **✅ Episode analysed** — then refresh the project (step 5).
  - `error` → **⚠️** and the `error` string. Show it plainly; do not hide it.
- [ ] A `404` means no analysis has been run for that episode. Show no chip.
- [ ] Do NOT start a run from the UI. There is no button for this — the
      transcript arrives from the Chrome extension.

---

## 5. Refresh when the analysis lands

This is the bit that is easy to miss.

The hooks and cuts arrive **after** Mosh has already opened the project — that is
the whole point of the feature. So a project opened at 2pm and analysed at 2:20pm
must pick up its hooks without a manual reload.

- [ ] When the status poll turns `complete`, call `restore/:jobId` again and
      replace the hooks queue, the cuts list, `socialPost` and `brainReport`.
- [ ] **Guard against wiping his work.** If he has edited the hooks or cuts since
      the project was opened, do NOT silently overwrite them. Show a small bar:
      *"The AI finished analysing this episode. Load its hooks and cuts?"* with
      **Load** and **Dismiss**. If he has not touched anything, just load them.
- [ ] Also re-read on every normal project open, so an episode analysed while he
      was away is correct the moment he opens it.

---

## 6. Reading the hook titles

No work here, just so the titles are not treated as noise. Hooks arrive with a
tag in front of the quote:

```
[CO-1 JAB · ★5 · A] "গোলামী"
[★4 · B] "মার্চে আমার জিরো সেল ছিল"
```

- `CO-1` … `CO-10` mark the ten hooks that form the **cold open**, in the order
  they should be stacked. `JAB`, `TABOO`, `FEAR` etc. are the slot names.
- `★` is the rating out of 5. `A` / `B` is the bucket (punch / mirror).

All 18–32 hooks land in the queue, best-rated first, so Mosh can delete down to
the ones he wants. The `CO-` tags are how he spots the montage while doing it.

- [ ] Do not strip or parse these tags. Show the title as it is.
- [ ] If hook titles are truncated in the list, make sure the full title is in a
      `title=` tooltip.

---

## 7. Please do NOT

- [ ] Do not add a "Run analysis" button. The transcript comes from the
      extension, and the backend needs it — there is nothing for a button to do.
- [ ] Do not auto-render or auto-download anything. Mosh reviews and renders by
      hand, on purpose.
- [ ] Do not reorder, re-rank, or filter the hooks in the frontend. The backend
      already ordered them.
- [ ] Do not hide failures. If a pass failed, the report says so and the status
      says so; both should be visible.

---

## Optional, only if it is easy

- [ ] Support `?manualJob=<jobId>` in the URL to open that project directly.
      tellatotube already links to this shape, so the link would start working
      the moment this exists. Without it, the link just opens the app and Mosh
      picks the episode off the top of the saved list, which is fine.
