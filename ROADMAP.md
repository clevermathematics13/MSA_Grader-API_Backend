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

### v157 — Reasoning Button + AI Suggestion Engine
- **🔍 Reasoning "?" button**: Every marking point row now has a blue `?` button. Click to expand a detailed reasoning panel showing: strategy used, required/found/missing values, student numbers, part-scope info, implication logic, method selection, and a colour-coded verdict. Toggle on/off; read-only (separate from correction flow).
- **💡 AI Suggestion per run**: After every grading run, the system generates one concise, actionable suggestion. If `ANTHROPIC_API_KEY` is configured in PropertiesService, calls Claude Sonnet for intelligent analysis. Falls back to a smart rule-based engine that detects patterns (global matches needing verification, multiple implied marks, many unmatched points, method-excluded rows, etc.).
- **🎨 UI polish**: `.reasoning-btn` (blue circle), `.reasoning-detail-panel` (blue theme with slide animation), `.ai-suggestion-banner` (purple gradient). Separate visual language from the yellow correction panels.
- **Files**: Index.html (CSS + JS), WebApp.js (`getAiSuggestion`, `buildSuggestionPrompt_`, `generateRuleBasedSuggestion_`)

### v156 — Animated Correction Details
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

## 🚦 Unfinished Processes — Audit

These are things **started but not yet completed**:

| # | Process | Status | What remains |
|---|---------|--------|-------------|
| 1 | **End-to-end Grade Work button** | 🟡 Partially tested | Modal opens ✅, image renders ✅, but "Grade Work" button → correction flow → "Save Corrections" has not been fully tested on real student work since v153 serialization fix. |
| 2 | **Bad learned rules cleanup** | 🟡 Known issue | Over-specific rules remain in the learned_rules spreadsheet (e.g., `"n_{n}+7 u_{1}=14" → "n+7"`, single-char patterns like `{`, `}`). Need manual curation or an automated cleanup pass. |
| 3 | **Correction detail panel (v143)** | 🟡 Built, not validated | The OCR Analysis correction detail panel was built in v143 with animations in v156. Needs verification that the correction panel in the *grading* flow (yellow panel under each mark point) works correctly with the new reasoning panel sitting above it. |
| 4 | **Step 4: Smarter rule generation** | 🔴 Not started | Classification of corrections as OCR errors vs. content edits. Only OCR errors should be persisted as learned rules. |
| 5 | **Step 5: Claude-in-the-loop grading** | 🟡 Foundation laid | v157 adds Claude API integration for suggestions. Extending to grading (Strategy 5: AI fallback for complex equivalence) needs a prompt design phase. |
| 6 | **Performance: cache learned corrections** | 🔴 Not started | Currently re-reads spreadsheet every grading call (~2s). Should use CacheService like OCR caching. |
| 7 | **Analytics dashboard** | 🔴 Not started | Tracking which corrections happen most, which questions need attention, OCR accuracy trends. |
| 8 | **Deployment cleanup** | 🟡 Ongoing | Approaching clasp's version limit. Need to archive old deployments. |

---

## 🗺 Full Pathway Forward — Phased Roadmap

### Phase A: Stabilization & Validation (Next)
> **Goal**: Every core flow works reliably end-to-end on real student work.

| Step | Task | Effort | Checkpoint |
|------|------|--------|-----------|
| A1 | Test full grading flow: select file → OCR → Grade → review reasoning → save corrections | 1 session | Grade 5 different questions, verify reasoning panels show correct data |
| A2 | Test correction flow: click ✗/✓ → fill reason → save → verify rules written to spreadsheet | 1 session | Confirm new rules appear in learned_rules sheet with structured feedback |
| A3 | Clean bad learned rules from spreadsheet (manual + script to flag suspicious rules) | 1 session | Write `auditLearnedRules_()` script, remove rules with pattern length ≤ 3 or pattern = replacement |
| A4 | Verify ? reasoning panel + AI suggestion banner on 10+ real grading runs | 1 session | Screenshot evidence of diverse suggestion types (global match warning, implied mark, method selection) |
| **Checkpoint A** | **All 4 steps pass → core product is stable** | | |

### Phase B: Performance & Caching (Week 2)
> **Goal**: Sub-3-second grading response, no redundant API calls.

| Step | Task | Effort | Checkpoint |
|------|------|--------|-----------|
| B1 | Cache learned corrections in CacheService (6h TTL, invalidate on write) | 2 hours | Grading call drops from ~5s to ~3s |
| B2 | Cache student profile rules similarly | 1 hour | Profile load < 100ms on cache hit |
| B3 | Pre-warm caches: trigger on page load or after deploy | 1 hour | First grading call after deploy is fast |
| B4 | Measure and log timing per phase (FETCH/OCR/QR/CLEAN/GRADE/PACKAGE) | 1 hour | Timing data visible in debug panel |
| **Checkpoint B** | **Average grading time < 3s (cached), < 8s (cold)** | | |

### Phase C: Smarter Rule Generation (Week 3)
> **Goal**: Corrections automatically classified; only genuine OCR errors persist.

| Step | Task | Effort | Checkpoint |
|------|------|--------|-----------|
| C1 | Classify corrections: compare edit distance, LaTeX structural similarity | 4 hours | Each rule tagged as `ocr_error`, `content_edit`, or `ambiguous` |
| C2 | Auto-expire rules after N grading sessions with no activation | 2 hours | Stale rules flagged for review |
| C3 | Teacher review UI: show flagged rules with one-click keep/delete | 3 hours | "Review AI Rules" button leads to a management panel |
| C4 | Smart rule generalization: `"1003.52" → "1003.52"` stays specific, but `"\\frac" → "\\frac"` becomes a pattern class | 3 hours | Fewer total rules, same correction coverage |
| **Checkpoint C** | **Learned rules sheet has < 50% current size, zero destructive rules** | | |

### Phase D: Claude-in-the-Loop Grading (Week 4-5)
> **Goal**: AI-powered Strategy 5 handles cases that rule-based strategies can't.

| Step | Task | Effort | Checkpoint |
|------|------|--------|-----------|
| D1 | Design prompt template: "Is this student work mathematically equivalent to {requirement}?" | 3 hours | Test on 20 known-tricky cases |
| D2 | Implement Strategy 5 in SRG_Grader.js as final fallback | 4 hours | Only fires when Strategies 0-4 return `awarded: false, type: 'none'` |
| D3 | Add confidence score to Claude response; require >0.8 to auto-award | 2 hours | Low-confidence results flagged for teacher review |
| D4 | Cost tracking: log API calls per question, set daily budget cap | 2 hours | Dashboard shows cost per grading session |
| D5 | A/B testing: run Strategy 5 in shadow mode, compare to teacher corrections | 4 hours | Measure accuracy improvement over pure rule-based |
| **Checkpoint D** | **Strategy 5 agrees with teacher corrections ≥ 85% of the time** | | |

### Phase E: Analytics & Insights (Week 6)
> **Goal**: Data-driven understanding of where the grader succeeds and struggles.

| Step | Task | Effort | Checkpoint |
|------|------|--------|-----------|
| E1 | Log every grading run: question, score, corrections, strategies used | 3 hours | Structured log sheet accumulating data |
| E2 | Per-question accuracy report: % of marks needing teacher correction | 3 hours | Top-10 "hardest to grade" questions identified |
| E3 | Per-student OCR quality report: avg corrections per scan | 2 hours | Students with poor scan quality flagged |
| E4 | Dashboard view in Index.html: charts showing accuracy trends | 4 hours | Visual analytics accessible from main menu |
| **Checkpoint E** | **Can answer: "What % of marks are graded correctly without correction?"** | | |

### Phase F: Production Hardening (Week 7-8)
> **Goal**: System is robust enough for class-wide deployment.

| Step | Task | Effort | Checkpoint |
|------|------|--------|-----------|
| F1 | Error recovery: retry logic for API failures (Mathpix, Claude, QR) | 3 hours | No silent failures; user always sees a meaningful message |
| F2 | Batch grading: grade multiple students in sequence, aggregate report | 4 hours | Teacher can grade entire class in one session |
| F3 | Export: grading results → CSV or Google Sheet for record-keeping | 2 hours | One-click export with corrections included |
| F4 | Version management: clasp deployment rotation, changelog auto-generation | 2 hours | Always < 15 active deployments |
| F5 | User documentation: in-app help, onboarding flow for new teachers | 3 hours | Help button in header opens guide |
| **Checkpoint F** | **Another teacher can use the system without developer assistance** | | |

---

## In Progress

### 🔄 End-to-End Testing
- Student Work OCR test pipeline now opens the modal ✅
- Image preview now renders correctly (base64 thumbnail) ✅
- Need to test: Grade Work button, Save Corrected OCR, correction detail panel
- Need to verify Strategy 3 part-aware grading on real student work

---

## Legacy Planned Items (absorbed into phased roadmap above)

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
