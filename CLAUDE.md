# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**PicGen** is a standalone Windows Electron desktop app for AI image generation. It's a floating window application that allows users to generate images using various AI image generation APIs (OpenAI, Gemini, Grok, Doubao Seedream, etc.) with automatic failover, provider health management, and task queuing.

**Architecture**: There is no separate web UI. The Express/WebSocket service is an internal local API started by Electron and bound to `127.0.0.1`.

## Commands

### Development
```bash
npm install                # Install dependencies
npm start                  # Start the app in development mode (auto-builds UI first)
npm run build:ui           # Build frontend only (React + Vite)
```

### Build
```bash
npm run build:win          # Build Windows directory (unpacked)
npm run build:win:portable # Build Windows portable executable (recommended)
# Output: dist/release/PicGen-2.3.2-x64.exe
# Staging: dist/.portable-build-* (auto-cleaned after success)
```

**Portable builds** store data in a `PicGenData` folder next to the executable. Move the entire folder (including `Local State`) to preserve history, suppliers, and encryption context for saved keys.

### Testing
```bash
npm test                                                    # Run unit tests (*.test.js)
node scripts/performance-benchmark.js . local              # Local scheduling overhead benchmark
node scripts/packaged-smoke.js "path\to\PicGen.exe" 2.3.2 # Packaged build smoke test
node scripts/packaged-smoke.js --source                    # Source smoke test (isolated profile)
node scripts/native-interaction-smoke.js                   # Verify dock/preview/cache behaviors
```

## High-Level Architecture

### Frontend Stack (2.3.0+)

**React + Appica UI** (`frontend/`):
- React 19.2.8, Appica UI 1.1.0 (MIT), Tailwind CSS 4, Vite
- All pages are React components: generation, history, queue, reverse-prompt, logs, settings, mask-editor
- Appica primitives: buttons, inputs, textareas, dropdowns, sequence tabs, dialogs
- Build output: `frontend-dist/` (included in Electron package)
- **Critical ownership rule**: React owns page structure and interactive component hosts. `desktop.js` controller owns explicitly empty collection/contenteditable/canvas hosts. Never make React reconcile controller-owned children.

**Supplier Manager** (`frontend/SupplierManager.jsx`, 2.3.3+):
- The supplier settings workspace is a React sub-root mounted on `#unifiedSupplierList` via `window.PicGenAppica.renderSupplierManager(props)` (`frontend/main.jsx`)
- **Self-made snap carousel** (transform-translated track, NOT Appica/embla): a `wheelHostRef` wheel handler advances one supplier per notch (throttled ~110ms, so a held scroll switches fast), plus prev/next buttons (disabled at the edges — no wrap) and index dots. embla 9.0.0-rc02's `scrollNext`/`scrollPrev`/`selectedSnap` misbehave under loop, which is why the carousel is hand-rolled; `selected` state is the source of truth for the index.
- **Overview card** per supplier: icon (lucide name or uploaded image), name, address (`website` field, else the baseUrl host), model stats, and an **aggregated health dot** (all groups available → green, all failed → red, mixed → amber). `data-selected` marks only the current card.
- **Below the carousel, following the selected supplier**: each config group is a **collapsible card** (`.unified-group-card`, summary row + expand-to-edit body) — no more per-role buttons. Only one editor expands at a time, so the smoke-driven ids (`#unifiedGroupNameInput`, `#unifiedGroupModelsRows`, `#unifiedDrawerSave`, `#unifiedGroupDelete`, …) stay unique. "新增配置组" appends a `NewGroupCard`; the overview card's pencil opens the identity form; "新增供应商" opens a new-supplier form (identity + first group in one POST).
- Health comes from `desktop.js` (`/api/providers/health`, keyed by group id) passed as the `health` prop; `applyProviderHealth` re-renders the manager so dots update live without disturbing open drafts. The supplier `website` field is persisted by `providerStore.js` (`normalizeUnifiedProvider`).
- `desktop.js renderUnifiedSuppliers()` supplies data + a REST action layer (`unifiedSupplierActions`); all validation and draft state live in React, pure draft logic in `frontend/supplierDraft.mjs` (unit-tested in `test/supplier-draft.test.js`). Save/test/discover/delete are guarded against double activation with a synchronous busy ref.
- Bridged native selects (`BridgedSelect` + `frontend/selectBridge.jsx`) keep smoke scripts scriptable; the bridge only forwards `onValueChange` while its popup is open or focused, so option churn (e.g. renaming a selected model) can never silently change a setting.
- Test/discover use draft endpoints (`POST /api/suppliers/test-draft`, `/discover-draft`) that operate on the submitted credentials, so a group can be tested before it is saved.

**Image Workspace / 图片工作台** (2.4, `frontend/workspace/`):
- One page merges reference annotation, size/scale reference and local-edit masks. It is a React sub-root on `#workspaceRoot` inside `<section id="workspacePage">` (a page like history/reverse-prompt, same `grid-row: 1 / -1`), mounted via `window.PicGenAppica.renderWorkspace(host, props)`. `desktop.js` only supplies `session` (images/mode/doc), `models` (`getGenerationModels()`), `targetName` (the active sequence), a small `api` (anchors, `addToReferences`, `saveAs`) and `onSend` → `sendWorkspaceToGeneration`. Everything goes to the **active sequence**.
- Entry points: nav `#workspaceNavBtn` (below 提示词反推; the sidebar spacer is keyed on `errorLogsBtn`, not an index), the unified image context menu's 发送到图片工作台 (`#workspaceImageBtn`, opens in 标注 mode; it replaced 标注 / 蒙版 and 创建比例参考 — switch 标注 / 比例 / 蒙版 in the workspace header), and the history drawer's 局部编辑 button (mask mode). Sending again **replaces** the canvas; on a reference card, a card carrying `reference.workspace` reopens the saved canvas. The old per-card dot buttons are gone.
- **Unified image context menu** (`#imageContextMenu`, `role="menu"`, the only image menu in the app): every image surface opens it — home strip, history grid/list/similar members, similar-strip cells, the find-similar head image, drawer thumbnail and large image, full preview, recycle-bin tiles, the reverse-prompt image and reference cards (`showReferenceContextMenu` just forwards). Items: 发送到参考图（活动序列 / 新建序列）, 发送到图片工作台 | 复制图片, 复制提示词, 另存为… | 查找相似图片 (+ 设为封面 / 移出此组 inside a similar group). A target is `{kind: 'history' | 'bin' | 'reference' | 'data', …}` (`toImageContextTarget` wraps a raw record, so `state.imageContextTarget = record` still works). Items a target can't do are **disabled, not hidden**, with the reason at the end of the row via `data-hint` (a disabled Appica button has `pointer-events:none`, so `title` never shows): a card's 活动序列 → 已在本序列, 查找相似 on bin → 还原后可用 and on data / unmatched cards → 仅限历史图片. Esc closes it. The workspace canvas has no image menu (it has its own 输出 menu).
- **复制图片 / 另存为… / 复制提示词** (main process): `desktop:copy-image` decodes in the sharp worker (`previewDecoder.bitmap`, premultiplied BGRA, any format, EXIF-rotated) and refuses an empty `nativeImage` before writing (Chromium's `writeImage` silently keeps the old clipboard). `desktop:save-image-as` is shared by the menu, the drawer and the workspace: system Save As dialog where the user picks folder and name (it starts in the last picked folder, remembered as `saveAsDirectory` in output-config.json across restarts; with none remembered (or it is unreachable within 1.5 s) only the file name is passed, so Windows opens the folder this app last picked in any open/save dialog — never a fixed folder; a name already taken there is proposed as name-1.ext, so the default action never overwrites, where the original itself lives; picking the original saves and counts nothing), the original copied as is (a missing embedded prompt is filled in from main's own record), the extension taken from the file header (png/jpg/webp/gif/bmp/avif, else the source's own). A successful copy or save of a **history** file counts as a take-out (`dragCount`, kind `'drag-out'`, source `'copy'` / `'save-as'`, recorded only in main; tooltip 拖出/复制/另存 N 次); reference caches, bin items and pixels are never counted. 复制提示词 puts the record prompt (else embedded metadata, else a full-index lookup by path / file name) on the clipboard — it no longer creates a sequence. Every clipboard write goes through `writeClipboard`; smoke launches set `PICGEN_SMOKE_CLIPBOARD=dry`, which only logs (`desktop:smoke-clipboard-log`, registered only in dry mode) and never touches the user's clipboard.
- **Coordinates are frame pixels** (long side 2048; ratio `original` = the first image's own aspect with no margin, the default when opening an image so local edits return the photo, not a padded frame). Pure logic in `workspaceModel.mjs` (frame, images, free-form comparison anchors — **no size lock / ground line**: `placeAnchor` starts an object at product height with its real aspect beside the product, shrinking into the wider side when neither fits, and `updateAnchor` moves/resizes/rotates it; `modelFamily` / `groupModelsByFamily`), `workspacePrompt.mjs`, `workspaceExport.js` (2D-canvas export independent of zoom: original / layout / annotated / OpenAI alpha mask / maskPreview / maskBounds / `composite` = everything visible, used by 输出到参考图 and 另存为). Undo is one timeline whose entries may hold a doc and/or a sized mask snapshot.
- **Canvas**: wheel zooms, **middle button pans** (`Konva.dragButtons = [0]` — Konva's default `[0, 1]` would drag the shape under the cursor), space + left drag also pans; left button always edits. Images and anchors share one Transformer (keep ratio, rotate).
- **Output menu** (`.ws-export`): 输出到参考图 adds the composite to the active sequence's references (prompt untouched); 另存为 goes through `desktop:save-image-as`, the same Save As as the image context menu (dock-safe save dialog; smoke sets `PICGEN_SMOKE_SAVE_AS_DIR` to skip it; the composite is pixels, so it is not counted).
- **清空** (`.ws-header .ws-clear`, `aria-label="清空工作台"`, after 重做): one undoable step with no confirm — the doc becomes `blankWorkspaceDoc()` (the nav entry's empty 4:3 canvas), the mask, 场景 and mask instruction are cleared (`restore()` carries them back as `fields`), and the notice says 撤销（Ctrl+Z）可恢复. Disabled while `isBlankDoc(doc)` or busy. It never touches `state.workspaceSession` (a new session id would re-initialise and drop the undo history). With an empty canvas the anchor library is disabled.
- **Hide technical details; match the model automatically**: the model is picked **by family** (Nano Banana / GPT / Grok / Seedream / 其他, from the configured models; last pick remembered in localStorage), not read from the sequence; sending switches the active sequence to that model (`applyWorkspaceModel`, same path as the model dropdown). `templateForModel`: OpenAI image models → separate mask (`maskImage`, alpha=0 = edit, soft per OpenAI docs, so the prompt restates the area); everything else (Gemini/Nano Banana/Grsai, Seedream, Grok) → the painted area is drawn red into the annotated image and `maskImage.guideIncluded` tells `maskEdit.js` not to add its own guide. The native OpenAI mask result is **always** pasted back: the Rolldeck relay returns only the painted area with pure black outside. The paste-back insets the edit area ~2–3px (sharp morphology treats dark as foreground, so `dilate` shrinks the white edit alpha) before the inward feather, because the model paints a dark ~2px band just inside the mask edge (the old thin black line). Other models' output is used as-is by default (full redraw, outside ≈ unchanged, no seam); they are pasted back only when the user turns on 严格保持涂抹区外不变 (`maskImage.composite`, hidden for OpenAI). Dilating the mask sent to the model made it redraw a larger area, so the native mask is sent exactly as painted.
- Sending: references are added via `addReferencePayloads(..., {collect})`, placeholders `@{__WS_LAYOUT__}` etc. are swapped for real aliases, and a pending local edit stores `sourceRefId`; `generateImages` builds one ordered list (source first) for both the images sent and `@` mention resolution. `reference.workspace = {doc, sourceFiles}` (source photos cached via `saveReferenceImage`, deleted with the card) persists through `normalizeReferences`/`serializeReference`.
- `protocolRouter.supportsOperation('mask-edit')` is true for all protocols; `maskEdit.js` keeps extra references after the source, builds a red translucent guide for non-native providers (unless `guideIncluded`), sends a standard `N:N` ratio to them (Grsai rejects `WxH`), and keeps the relay-proven mask colours (kept = opaque white, edit = transparent black; an all-white mask made the Rolldeck relay repaint the region blind).
- **Anchor library** `assets/size-anchors/*.svg` + `anchors.json`: viewBox in millimetres, bottom = ground line (tested). `renderable` anchors (bench, door, car, pencil, can, coin, battery) are turned into real objects "at the same size and position"; scale-only ones (people, hands) are named in the prompt as "do not generate". Rectangles (credit card, A4) are excluded. `library:false` hides the legacy door+person / car+person combos (still used by the e-commerce chart's auto pick in `sizeReferenceLayout.pickAnchor`).
- Smoke: `scripts/workspace-flow.js` (real mouse/keyboard, incl. middle-button pan and free anchor drag) + the refinement flow's local edit; `window.PicGenWorkspaceDebug.doc()` / `.toClient(framePoint)` are read-only hooks for assertions.

**Desktop Controller** (`desktop.js`):
- Integration layer for IPC, task state, persisted drafts, rich prompt editing
- Owns specialized canvas/history interactions and thumbnail generation
- Bridge between React UI and Electron/WebSocket backend

### Core Components

**Electron Main Process** (`electron-main.js`):
- Manages the floating window with collapsed (92x52) and expanded (460x800) states
- Handles tray integration, window positioning, always-on-top behavior, and docking (2.3.1)
- **Docking behavior**: Drag titlebar within 16px of screen edge to dock. Auto-hides to 12px tab after 700ms. Hover/click reveals. Pin button pauses auto-hide. Editing/menus suspend auto-hide.
- Manages file I/O for generated images with metadata embedding (PNG/JPEG/WebP)
- Implements image history with thumbnail generation, discovery, and perceptual similarity clustering (2.2.2)
- Stores data in `%APPDATA%\PicGen\` (installed) or `PicGenData\` folder (portable builds)

**Local API Server** (`server.js`):
- Express + WebSocket server bound to `127.0.0.1` (random port)
- Routes for provider management, task submission, prompt optimization, image operations
- Broadcasts task events and provider status updates via WebSocket

**Task Queue** (`taskQueue.js`):
- Round-robin scheduling across multiple "sequences" (UI tabs/slots)
- Per-sequence concurrency limit (default 3) + global limit (default 12)
- Automatic failover with retry on provider failure
- Task lifecycle: `pending` → `running` → `completed`/`failed`/`cancelled`
- Progress tracking with phases: `queued`, `routing`, `requesting`, `downloading`, `saving`, `completed`

**Provider Manager** (`providerManager.js`):
- Health tracking with circuit breakers (using `opossum`) and rate limiters (using `bottleneck`)
- Automatic provider selection based on: `priority`, `balanced` (load), `speed`, `price`, or `fixed`
- Failover strategy: tries up to `maxAttempts` providers (default 3) when errors are retryable
- Provider states: `available`, `degraded`, `failed` with cooldown periods
- API key rotation when multiple keys are configured
- **Routing modes** (2.2.1+):
  - `priority`: Use smallest priority number first
  - `balanced`: Use occupied capacity first, priority for ties (no weight field)
  - `price`: Prefer cheapest configured per-image price
  - `speed`: Prefer lowest observed EWMA latency
  - `fixed`: Pin to single provider, queue at capacity without switching

**Protocol Router** (`protocolRouter.js`):
- **Critical routing logic**: Protocol is inferred from model name, NOT from provider domain
- Supported protocols: `gemini-native`, `openai-images`, `xai-imagine`, `grsai-nano-banana`, `openai-chat`
- Model name normalization removes prefixes (`google/`, `models/`), whitespace, and vendor tags
- Route selection respects provider-level `modelRouting` and `modelCapabilities` config

**Image API Service** (`apiService.js`):
- Unified interface for multiple image generation protocols
- Connection pooling with keep-alive agents (avoids TLS handshake on every request)
- Proxy support: `direct`, `system` (reads environment), or `custom` (explicit proxy URL)
- Download retry with exponential backoff (default 3 attempts)
- Prompt metadata embedding into generated images (iTXt chunks for PNG, XMP for JPEG/WebP)

**Image API Profiles** (`imageApiProfiles.js`):
- Capability definitions for each model family: supported ratios, max references, quality options
- Model name collision detection (e.g., `gpt-image-mini` contains substring `gemini`)
- Dimension resolution for OpenAI Image2, Gemini, Grok, and legacy models

### Key Data Flow

1. **User submits task** → React UI → `desktop.js` controller → WebSocket → `server.js`
2. **Batch submission** (2.2.1+) → Single `/api/tasks/batch` request shares reference images (single-task endpoint still available)
3. **Server resolves provider** → `providerStore` + `failoverConfig` → task enrichment
4. **Task enqueued** → `taskQueue.enqueue()` → round-robin scheduling across sequences
5. **Provider reservation** → `providerManager.reserve()` → selects provider by strategy (priority/balanced/price/speed/fixed)
6. **API call** → `apiService.generateImage()` → protocol-specific request builder
7. **Download result** → retry with exponential backoff → base64 conversion
8. **Store result** → `electron-main.js` → metadata embedding → file write → history index update
9. **Broadcast event** → WebSocket → React UI updates with perceptual similarity clustering (2.2.2)

### Storage Locations

- **Providers**: `%APPDATA%\PicGen\providers.json` (unified suppliers, groups, models, keys)
  - Legacy `api-providers.json` and `chat-providers.json` are imported once and kept as timestamped backups
- **Config**: `failover-config.json`, `proxy-config.json`, `output-config.json`
- **Images**: `%APPDATA%\PicGen\desktop-cache\images\` (default), or user-configured directory
- **Cache**: `previews\`, `thumbnails\`, `references\` subdirectories
- **Logs**: `logs\recent-errors.json`
- **History**: `recent-images.json` (schema version 4, includes discovered orphan images)
- **Portable builds**: Replace `%APPDATA%\PicGen\` with `PicGenData\` folder next to executable

### Protocol Routing Rules

**IMPORTANT**: The protocol is determined by model name analysis, not provider URL. A Gemini model sent to an OpenRouter relay will still use `gemini-native` protocol if the model name matches Gemini patterns.

**Inference priority**:
1. Provider-level `modelRouting[model].protocol` override
2. Model name pattern matching (e.g., `imagen`, `gemini`, `gpt-image`, `grok-imagine`, `seedream`)
3. Provider-level `modelCapabilities[model].supported_endpoint_types`
4. Provider domain heuristics (e.g., `generativelanguage.googleapis.com` → `gemini-native`)

**Model name normalization**:
- Remove vendor prefixes: `google/gemini-3-flash` → `gemini-3-flash`
- Lowercase and strip separators: `GPT_Image_Mini` → `gptimagemini`
- Collision avoidance: Use prefix anchoring (e.g., check for `^gemini`, not substring `gemini`)

**Special cases**:
- Grsai Nano Banana: Uses dedicated async protocol (`grsai-nano-banana`), not Gemini Native
- OpenAI-compatible Gemini relays: Can accept aspect ratios in the `size` field (e.g., `16:9`)
- Grok models: Support both native (`xai-imagine`) and OpenAI-compatible protocols

### Failover Behavior

**When failover triggers**:
- HTTP status codes: 408, 409, 425, 429, 500, 502, 503, 504
- Network errors: `ENOTFOUND`, `EAI_AGAIN`, `ECONNRESET`, `ETIMEDOUT`
- Provider circuit breaker opens after consecutive failures reach threshold (default 3)

**When failover does NOT trigger**:
- User-side errors (4xx except listed above)
- Abort signals or cancelled tasks
- Result download failures (marked as `ambiguous` to prevent double-billing)

**Failover strategy**:
- `balanced` (default): Load-balance by weight, latency, and last-used time
- `priority`: Exhaust higher-priority providers before lower ones
- `price`: Prefer cheaper providers (from `modelPricing` config)
- `speed`: Prefer providers with lower EWMA latency
- `fixed`: Pin to a single provider (bypass circuit breaker)

### Image Metadata

Generated images embed prompt metadata:
- **PNG**: `iTXt` chunk with keyword `prompt` + XMP packet with keyword `XML:com.adobe.xmp`
- **JPEG**: APP1 XMP segment with `http://ns.adobe.com/xap/1.0/` header
- **WebP**: `XMP ` chunk in RIFF container

Metadata payload (JSON in XMP):
```json
{
  "schema": "picgen.prompt/v1",
  "id": "task_...",
  "prompt": "...",
  "ratio": "16:9",
  "model": "gemini-3-flash-image-2",
  "providerName": "Provider Name",
  "mimeType": "image/png",
  "width": 1280,
  "height": 720,
  "createdAt": 1234567890
}
```

## Common Patterns

### Adding a New Image API Protocol

1. Add protocol constant to `protocolRouter.js` → `PROTOCOLS`
2. Implement model detection in `imageApiProfiles.js` → `isXxxImageModel()`
3. Add request builder in `apiService.js` → `buildXxxImageRequest()`
4. Update `generateImage()` to handle the new protocol
5. Update `inferProtocol()` with model name pattern matching

### Debugging Provider Issues

1. Check provider health: `providerManager.getHealthRatings()`
2. Inspect circuit breaker state: `state.breaker.opened` / `state.breaker.halfOpen`
3. Review cooldown: `state.cooldownUntil` vs `Date.now()`
4. Check recent errors: `state.lastError`, `state.consecutiveFailures`
5. Verify model routing: `inferProtocol(provider, model)` and `supportsOperation(provider, model, operation)`

### Testing Provider Connections

Use the built-in test endpoints:
- Image provider: `testImageProviderConnection({ provider, apiKey, model })`
- Chat provider: `testChatProviderConnection({ provider, apiKey, model })`
- Proxy reachability: `testProxyReachability({ targets, timeoutMs })`

### Adding React Components

1. Create component in `frontend/` using Appica UI primitives
2. Import and use in page components (e.g., `frontend/pages/SettingsPage.jsx`)
3. For controller-owned DOM (canvas, contenteditable), create empty host div in React
4. Let `desktop.js` populate the host via `querySelector` after React mount
5. Never let React reconcile controller-owned children - leads to state loss

### Frontend Development Workflow

1. `npm run build:ui` compiles React + Vite → `frontend-dist/`
2. `npm start` auto-runs `build:ui` via prestart hook
3. For isolated UI development: `npm run build:ui` then test in browser (if applicable)
4. Build commands (`build:win`, `build:win:portable`) auto-run `build:ui` first

## Important Notes

- **Never guess parameter names**: Read provider schema/documentation before setting parameters
- **Model name is the routing source**: Don't infer protocol from provider domain alone
- **Failover is stateful**: Circuit breakers and cooldowns persist across tasks
- **History is eventually consistent**: The index is rebuilt from disk on every load to recover orphaned files
- **Proxy config affects both layers**: Node.js fetch agents AND Chromium session proxy
- **Keep-alive is critical**: Image relays can have 0.6s-8.4s TLS handshakes; connection reuse saves seconds per request
- **React/controller ownership boundary**: React owns page structure; `desktop.js` owns canvas/contenteditable/collection hosts. Never mix.
- **Portable builds are self-contained**: `PicGenData` folder must stay with executable. Contains encryption context for saved keys.
- **Unified provider storage**: `providers.json` replaced separate `api-providers.json`/`chat-providers.json` in 2.3.x
- **Perceptual similarity**: Uses `blockhash-core` for visual clustering (2.2.2), runs in Web Worker, no uploads
- **Task cancellation scope** (2.2.1): Stops reference uploads, result downloads, retry delays. Saving completed images cannot be cancelled.
- **Uncertain generation outcomes**: Warn about possible billing before automatic retry when outcome is ambiguous
