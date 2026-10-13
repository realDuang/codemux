# Web and mobile PWA

CodeMux's Web client can run in a browser or be installed on a phone's home screen. Both use the same Web application and connect to the existing Gateway. Engines, project files, and commands remain on the host running CodeMux. The Web bundle runs outside Electron and has its own build, but live operations still require the existing CodeMux host. Extracting a standalone server runtime is a separate migration.

## Build boundaries

| Client | Entry | Build command | Output |
| --- | --- | --- | --- |
| Electron | `index.html`, `src/main.tsx` | `bun run build:desktop` | `out/renderer`, `out/main`, `out/preload` |
| Web / PWA | `web/index.html`, `src/web/main.tsx` | `bun run build:web` | `out/web` |

`bun run build` produces both clients. Distribution commands also build both, and Electron Builder includes both through `out/**/*`. The packaged HTTP server serves `out/web`; the Electron window continues to load `out/renderer/index.html` through `file:`.

Shared pages, message renderers, stores, and Gateway types remain in `src`. Installation, Service Worker registration, update UI, and mobile viewport handling live under `src/web` and are imported only by the Web entry. Electron has no manifest or Service Worker registration.

`vite.web.config.ts` defines the Web build. The standalone development configuration in `vite.config.ts` extends it with the existing API middleware and Gateway proxy. Development does not register a Service Worker. Electron development continues to use `electron.vite.config.ts`.

## Host and install

Build and package CodeMux normally, enable its existing remote access, and open its fixed HTTPS address. A named Cloudflare Tunnel or an existing HTTPS reverse proxy can provide that address. Serve the application and `/api/*` and `/ws` on the same origin, at the domain root.

A changing quick-tunnel hostname changes the installed application's origin. Use a stable hostname for regular installation. Plain HTTP on a LAN IP is suitable for ordinary browser access but does not provide the secure context required by Service Workers; `localhost` is the development exception.

- **iPhone / iPad:** Open the address in Safari, choose Share, then Add to Home Screen. Authorize the installed client if requested; browser and installed storage need not be shared.
- **Android:** Open the address in a browser that supports installation and use the CodeMux install control or the browser's installation menu.
- **Desktop:** Use the installation menu in a supported browser. Ordinary browser access remains available.

## Connection, drafts, and updates

After an online visit, the Service Worker caches the static application shell. Authentication responses, conversations, files, and commands are not cached. The host and network connection are still required for live work.

The Web client checks its connection when it returns to the foreground or the network comes back, then synchronizes the current conversation and pending interactions. Offline input remains editable while sending is disabled. Failed sends preserve recoverable input without replacing edits made after submission; commands are never automatically resubmitted.

Text drafts are saved locally per authorized device and session, with bounded retention. Image attachments remain in memory and must be attached again after reloading. The application explains this beside attachments and prevents an update refresh while images remain in drafts. A storage failure leaves the current text in memory and is shown in the input area.

New application versions wait for an explicit refresh. Each build has a unique ID and its own precache. Open pages report their build IDs so old immutable JavaScript and CSS chunks remain available until those pages close; an unresponsive page or an in-progress update postpones cache cleanup. This lets an old tab open a lazy page after another tab updates, even when the old files are no longer on the server.

HTML, the manifest, and the Service Worker revalidate; only content-hashed build assets receive immutable caching. Missing assets return 404 instead of the SPA's HTML. Navigation fallback is limited to application routes. Authentication and other API responses are never served from the version caches.

Background push notifications, offline conversation history, and persistent terminal reattachment are separate capabilities. The current terminal lifecycle still ends its host process when its owning WebSocket disconnects.

## Validation

Run type checking, the relevant unit tests, and `bun run build`. Verify the built Web client rather than a Vite development page when checking installation, offline loading, and updates. Browser E2E fixtures serve `out/web`.

Check mobile login and authorization, installation metadata, text entry with the keyboard open, portrait/landscape layout, draft restoration after reload, failed sends, foreground message recovery, and an explicit update from one build to another. Inspect the desktop renderer output to ensure that it does not include the PWA runtime. Actual home-screen installation and OS keyboard/background behavior require iOS and Android devices; Chromium viewport emulation alone does not establish those results.

### Release candidate checks (2026-10-13)

The PWA candidate was assembled from the committed application plus only the PWA changes, excluding unrelated in-progress desktop integrations, then installed with the frozen Bun lockfile.

- Desktop and Web builds, TypeScript checks, and the unit suite passed. The suite contains 3,720 passing tests and three existing skipped legacy server-wrapper tests.
- The built manifest has no Chromium installability errors. Desktop output contains neither a manifest nor the PWA registration runtime.
- Ego Browser checks against the standalone mock Gateway exercised mobile navigation, draft restoration after reload, editable offline drafts with disabled sending, interrupted sends and recovery, and updating an open client.
- In a two-build check, one tab updated while an older tab retained its input. The retired Settings chunk returned HTTP 404 from the server. With the server then stopped and HTTP cache disabled, the old tab still loaded Settings and retrieved that chunk with status 200 from its version cache. Closing that tab allowed its old cache to be removed.
- These checks establish an independently buildable and runnable Web client. They do not establish a standalone production backend: the mock Gateway is a test fixture, while the current production host still uses Electron.
- Native iOS/Android installation, physical keyboard behavior, live engine credentials, and a deployed HTTPS origin were not exercised by this candidate check.
