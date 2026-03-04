# MSA Grader — Project Roadmap & Changelog

> This file tracks what has been built, what's in progress, and what's planned.
> Updated automatically as development progresses.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  CLIENT (Index.html)                                            │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────────────┐   │
│  │ Status    │  │ Debug Panel  │  │ Student OCR Modal      │   │
│  │ Log       │  │ (live poll)  │  │ (image + LaTeX + grade)│   │
│  └──────────┘  └──────┬───────┘  └───────────┬────────────┘   │
│                       │ poll                   │ google.script  │
│                       │ getServerLogs()        │ .run           │
├───────────────────────┼───────────────────────┼────────────────┤
│  SERVER (Apps Script)  │                       │                │
│                       ▼                       ▼                │
│  ┌─────────────────────────────────────────────────────┐       │
│  │  testStudentWorkOcr()  — WebApp.js                  │       │
│  │  7-phase pipeline:                                   │       │
│  │  1. FETCH   — DriveApp file metadata                │       │
│  │  2. OCR     — Mathpix API (cached 6h)               │       │
│  │  3. QR      — QR server API (cached 6h)             │       │
│  │  4. CROP    — Stored coords → Markers → Manual      │       │
│  │  5. CLEAN   — Crossed-off → Global rules → Student  │       │
│  │  6. IMAGE   — Thumbnail base64 for preview          │       │
│  │  7. PACKAGE — JSON string return                    │       │
│  └──────┬──────────┬──────────────┬────────────────────┘       │
│         │          │              │                             │
│         ▼          ▼              ▼                             │
│  ┌───────────┐ ┌──────────┐ ┌──────────────┐                  │
│  │MSA_Helpers│ │OCR_Learn │ │StudentOCR_   │                  │
│  │_And_Pass1 │ │.js       │ │Profile.js    │                  │
│  │(Mathpix)  │ │(global   │ │(per-student  │                  │
│  └───────────┘ │ rules)   │ │ rules)       │                  │
│                └──────────┘ └──────────────┘                  │
│                                                                │
│  ┌─────────────────────────────────────────────────────┐       │
│  │  SRG_Grader.js — 5-strategy grading engine          │       │
│  │  Strategy 0: Zero-tolerance (exact)                 │       │
│  │  Strategy 1: Exact assignment (part-aware v144)     │       │
│  │  Strategy 2: Subset matching                        │       │
│  │  Strategy 3: Numeric match (part-aware v144)        │       │
│  │  Strategy 4: Semantic / AI fallback                 │       │
│  └─────────────────────────────────────────────────────┘       │
│                                                                │
│  ┌─────────────────────────────────────────────────────┐       │
│  │  MSA_Drive.js — logging (msaLog_, msaWarn_, msaErr_)│       │
│  │  Now streams to CacheService for live debug panel   │       │
│  └─────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────┘
```

---

## Completed (most recent first)

### v155 — Image Preview Fix + Debug UX + Structured Logging
- **🖼 Thumbnail fix**: Drive thumbnail URLs (`lh3.googleusercontent.com`) require auth cookies the browser doesn't have. Now fetches thumbnail bytes server-side → returns as base64 data URL.
- **📋 Copy button**: "📋 Copy" button on Server Debug Log header copies all entries to clipboard.
- **📊 Structured logging**: 7-phase pipeline with headers (`═══`, `───`), phase numbers (`[1/7 FETCH]` through `[7/7 PACKAGE]`), context explanations, and a summary footer.
- **Files**: WebApp.js, Index.html, MSA_Drive.js

### v154 — Live Server Debug Panel
- **🔧 Log streaming**: `msaLog_()` buffers entries to `CacheService` keyed by session ID. Client polls `getServerLogs()` every 1s. Dark-themed panel auto-opens when Test OCR runs.
- **Architecture**: `startLogSession()` → `setLogSession_()` → `appendToLogSession_()` → `getServerLogs(sessionId, fromIndex)`
- **Files**: MSA_Drive.js (log buffer), WebApp.js (session activation), Index.html (UI + polling)

### v153 — JSON String Serialization Fix
- **Root cause**: `google.script.run` silently returns `null` when it can't serialize complex nested objects — even when the server completes in 2.8s. NOT a timeout.
- **Fix**: Server returns `JSON.stringify(payload)`, client does `JSON.parse(raw)`.
- **Files**: WebApp.js, Index.html

### v152 — QR Decode Performance
- Skip 2.5MB blob read: use `file.getSize()` instead of `blob.getBytes().length`
- Drop s2000 thumbnail attempt (always >1MB), start at s1600
- **Files**: WebApp.js

### v151 — CacheService for OCR + QR
- Mathpix OCR results cached with key `mathpix_ocr_` + fileId (6h TTL, <100KB)
- QR decode results cached with key `qr_decode_` + fileId (6h TTL)
- First call: ~19s. Cached calls: ~3s.
- **Files**: MSA_Helpers_And_Pass1.js, WebApp.js

### v150 — Client Watchdog Timer
- 30-second watchdog auto-recovers UI if `google.script.run` never calls back
- Console.log confirms: `handleStudentOcrResult FIRED, result= null`

### v149 — Null Guard + file.getSize()
- Added null guard in success handler for timeout case
- Used `file.getSize()` instead of expensive `file.getBlob().getBytes()` for size check

### v148 — Drive API Fix + UI Error Catching
- `Drive.Files.get()` → `UrlFetchApp.fetch()` (Advanced Drive Service not enabled)
- More rule guards: block LaTeX structural commands, equation rewrites
- Try-catch in client `handleStudentOcrResult` to surface JS errors

### v147 — Destructive Rules Safety + Thumbnail Fallback
- Safety guards in `loadLearnedCorrections_()`: skip ≤2 char patterns, no-ops, short deletions
- Images >500KB use Drive thumbnail URL instead of 3.4MB base64

### v146 — Diagnostic Logging
- Checkpoint logging throughout `testStudentWorkOcr`
- Revealed: destructive learned rules (88 replacements destroying LaTeX) + 3.4MB payload

### v145 — String Coercion for Learned Corrections
- `rule.pattern.replace is not a function` — Google Sheets returns Numbers for numeric cells
- Fixed with `String()` coercion in `loadLearnedCorrections_()`

### v144 — Strategy 3 Spatial Blindness Fix
- `getTextForPart_()` helper segments student text by part markers (a), (b), (c)
- Strategy 1 and Strategy 3 now search within the correct part segment
- Cross-part leak detection: numbers found globally but not in correct part → `awarded: false, score × 0.2`
- 7 new tests, 114 total passing

### v143 — Correction Detail Panel
- Interactive panel showing before/after for each OCR correction applied
- Shows global rules, student-specific rules, and crossed-off detections

---

## In Progress

### 🔄 End-to-End Testing
- Student Work OCR test pipeline now opens the modal ✅
- Image preview now renders correctly (base64 thumbnail) ✅
- Need to test: Grade Work button, Save Corrected OCR, correction detail panel
- Need to verify Strategy 3 part-aware grading on real student work

---

## Planned / Ideas

### 📋 Step 4: Smarter Rule Generation
- Currently: teacher edits OCR text → diff saved as literal pattern/replacement
- Problem: over-specific rules (e.g., `"n_{n}+7 u_{1}=14" → "n+7"`)
- Goal: classify corrections as OCR errors vs. content edits, only persist OCR errors
- Approach: compare edit distance, LaTeX structure similarity

### 🤖 Step 5: Claude-in-the-Loop Grading
- For complex grading corrections that rule-based matching can't handle
- Claude evaluates "is this student work mathematically equivalent to the mark scheme?"
- Would run as Strategy 4 fallback when Strategies 0-3 can't confidently assign marks

### ⚡ Performance Optimizations
- Cache learned corrections in CacheService (currently re-reads spreadsheet every call, ~2s)
- Cache student profile rules similarly
- Pre-warm caches on deploy or on page load
- Consider splitting pipeline into phases with progress callbacks

### 🧹 Cleanup
- Delete bad rows from learned_rules spreadsheet (patterns: `{`, `}`, `1`, `M`, `\begin{array}{l}`)
- Archive old deployments (approaching clasp's 20-version limit)
- Remove diagnostic `Line N: center=...` logs (useful for debugging, noisy for production)

### 📊 Analytics / Insights
- Track: which corrections are applied most often per question
- Track: which students trigger the most OCR corrections
- Dashboard showing OCR accuracy trends over time
- Identify questions where OCR consistently struggles (complex diagrams, etc.)

---

## Test Suite

| Suite | Tests | File |
|---|---|---|
| Grader (SRG) | ~75 | tests/grader.test.js |
| OCR Verify | ~20 | tests/ocr_verify.test.js |
| Student Profile | ~10 | tests/student_profile.test.js |
| Sigma Notation | ~9 | tests/sigma.test.js |
| **Total** | **114** | |

---

## Key Files Reference

| File | Purpose |
|---|---|
| WebApp.js | Main web app backend, `testStudentWorkOcr` pipeline |
| Index.html | Full grading UI, modals, debug panel |
| SRG_Grader.js | 5-strategy grading engine |
| GradingAI.js | 4-pass grading orchestrator |
| OCR_Learn.js | Global learned correction rules |
| StudentOCR_Profile.js | Per-student adaptive corrections |
| MSA_Helpers_And_Pass1.js | Mathpix OCR wrapper (with caching) |
| MSA_Drive.js | Drive helpers + logging (msaLog_ with CacheService streaming) |
| MSA_Config.js | Configuration management |
| OCR_Verify.js | OCR text verification and cleanup |
