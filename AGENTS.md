# CodeMux - AI Agent Development Guide

## Project Overview

**CodeMux** is a standalone web interface for accessing OpenCode through a browser. It's a locally-run application that automatically starts an OpenCode server and provides a web UI with random access code authentication.

### Tech Stack

- **Frontend Framework**: Vite + SolidJS
- **Styling**: Tailwind CSS v3.4.0
- **Package Manager**: Bun
- **Communication**: REST API + Server-Sent Events (SSE)
- **Authentication**: 6-digit random code
- **Internationalization**: @solid-primitives/i18n (English & Simplified Chinese)

### Project Structure

```
codemux/
├── src/
│   ├── pages/          # Page components
│   │   ├── Login.tsx   # Login page (6-digit code)
│   │   ├── Chat.tsx    # Main chat interface
│   │   ├── Settings.tsx        # Settings page
│   │   └── RemoteAccess.tsx    # Remote access configuration
│   ├── components/     # UI components
│   │   ├── SessionSidebar.tsx  # Session list sidebar
│   │   ├── MessageList.tsx     # Message list
│   │   ├── PromptInput.tsx     # Input box
│   │   ├── ModelSelector.tsx   # Model selection dropdown
│   │   ├── LanguageSwitcher.tsx # Language switcher component
│   │   └── share/              # Message rendering components ported from OpenCode
│   │       ├── part.tsx        # Part component entry
│   │       ├── content-*.tsx   # Renderers for different content types
│   │       └── icons/          # Icon components
│   ├── lib/            # Core libraries
│   │   ├── auth.ts             # Authentication management (localStorage)
│   │   ├── opencode-client.ts  # OpenCode API client
│   │   └── i18n.tsx            # i18n provider and utilities
│   ├── locales/        # Translation files
│   │   ├── en.ts               # English translations
│   │   └── zh-CN.ts            # Simplified Chinese translations
│   ├── stores/         # State management
│   │   ├── session.ts  # Session state
│   │   ├── message.ts  # Message state
│   │   └── config.ts   # Configuration state
│   ├── types/          # TypeScript type definitions
│   │   └── opencode.ts # OpenCode API types
│   └── main.tsx        # Application entry
├── scripts/
│   └── start.ts        # Startup script (generate code + start services)
├── vite.config.ts      # Vite config (includes auth middleware)
└── package.json        # Dependencies and scripts
```

---

## Core Architecture

### 1. Startup Process

**Start Command**: `bun run start`

Execution flow:

1. `scripts/start.ts` generates a 6-digit random access code
2. Access code saved to `.auth-code` file
3. Console displays access code (user needs to remember it)
4. Concurrent startup:
   - Vite dev server (port 5174)
   - OpenCode server (port 4096)

### 2. Authentication Flow

#### 2.1 Access Code Verification

- **Location**: Custom middleware in `vite.config.ts`
- **Endpoint**: `POST /api/auth/verify`
- **Verification Logic**:
  ```typescript
  if (code === authCode) {
    const token = generateRandomToken();
    tokenStore.add(token);
    return { token };
  }
  ```

#### 2.2 Token Management

- **Storage**: `localStorage.setItem('auth_token', token)`
- **Usage**: Redirect to `/chat` after successful login
- **Verification**: Check token existence before accessing any page

### 3. API Proxy

**Configuration**: `vite.config.ts` → `server.proxy`

```typescript
'/opencode-api': {
  target: 'http://localhost:4096',
  changeOrigin: true,
  rewrite: (path) => path.replace(/^\/opencode-api/, ''),
}
```

- Frontend requests `/opencode-api/*` → Forward to `http://localhost:4096/*`
- OpenCode server runs on port 4096

### 4. State Management

Uses SolidJS `createStore` for reactive state management.

#### 4.1 Session Store (`src/stores/session.ts`)

```typescript
{
  list: SessionInfo[],      // Session list
  current: string | null,   // Current session ID
  loading: boolean          // Loading state
}

SessionInfo {
  id: string,
  title: string,
  createdAt: string,        // ISO time string
  updatedAt: string
}
```

#### 4.2 Message Store (`src/stores/message.ts`)

```typescript
{
  bySession: {
    [sessionId: string]: {
      [messageId: string]: MessageWithParts
    }
  }
}

MessageWithParts = MessageV2.Info & {
  parts: MessageV2.Part[]
}
```

**Important**:

- Messages are stored grouped by session, supporting multi-session message caching
- Uses `MessageV2.Info` type (includes `id`, `sessionID`, `role`, `time`, `parts`, etc.)
- Field naming uses uppercase `ID` (e.g., `messageID`, `sessionID`)

---

## OpenCode API Integration

### API Client (`src/lib/opencode-client.ts`)

#### Session Management

```typescript
// Get session list
listSessions(): Promise<Session.Info[]>

// Create new session
createSession(title?: string): Promise<Session.Info>

// Delete session
deleteSession(id: string): Promise<void>

// Get session details
getSession(id: string): Promise<Session.Info>
```

#### Message Operations

```typescript
// Send message
sendMessage(sessionId: string, text: string): Promise<void>
// Request format: { parts: [{ type: "text", text: "..." }] }

// Get all messages in a session
getMessages(sessionId: string): Promise<MessageV2.Info[]>
// Response format: [{ info: {...}, parts: [...] }]
```

#### SSE Connection

```typescript
connectSSE(
  onEvent: (event: { type: string; data: any }) => void
): () => void  // Returns cleanup function
```

**SSE Event Format** (OpenCode Server):

```json
{
  "directory": "/path/to/project",
  "payload": {
    "type": "message.part.updated",
    "properties": {
      "part": { "id": "...", "messageID": "...", "type": "text", ... }
    }
  }
}
```

**Supported Event Types**:

- `message.part.updated` → Message content update (real-time streaming)
- `session.updated` → Session information update
- `session.created` → New session created
- `message.updated` → Message metadata update

**Parsing Logic**:

```typescript
const eventType = parsed.payload.type;
const properties = parsed.payload.properties;

if (eventType === "message.part.updated") {
  onEvent({ type: "message.part.updated", data: properties.part });
}
```

---

## Key Component Descriptions

### Chat.tsx (Main Chat Interface)

#### Core Features

1. **Session Management**
   - `initializeSession()`: Load session list and current session messages on init
   - `handleSelectSession(sessionId)`: Switch sessions
   - `handleNewSession()`: Create new session
   - `handleDeleteSession(sessionId)`: Delete session

2. **Message Handling**
   - `loadSessionMessages(sessionId)`: Load messages for specified session
   - `handleSendMessage(text)`: Send user message
   - `handleSSEEvent(event)`: Handle SSE events, update messages in real-time

3. **Reactive Data**
   - `currentMessages`: Use `createMemo` to compute current session's message list
   - Automatically sort by `time.created`

#### Important Notes

- **Field Naming**: Use `messageID`, `sessionID` (uppercase ID), not `messageId`
- **Message Structure**: Preserve full `MessageV2.Info` structure, use `...msgInfo` spread
- **Time Fields**: Use `time.created` and `time.updated` (timestamps), don't create custom `createdAt`

### SessionSidebar.tsx (Session Sidebar)

- Display session list (sorted by update time, descending)
- Highlight current session
- Support create, switch, delete sessions
- Relative time display (just now, X minutes ago, X hours ago, X days ago)

### MessageList.tsx (Message List)

- Iterate message array, render parts for each message
- Filter out internal part types (`step-start`, `snapshot`, `patch`, `todoread`, etc.)
- Use `Part` component to render each part

### Part.tsx and content-\*.tsx

These components are ported from the OpenCode main repository, responsible for rendering different types of message content:

- `content-text.tsx`: Plain text
- `content-markdown.tsx`: Markdown content (using marked library)
- `content-code.tsx`: Code blocks (using shiki highlighting)
- `content-diff.tsx`: Code differences
- `content-bash.tsx`: Bash command execution results
- `content-error.tsx`: Error messages

---

## Data Flow Diagram

```
User Input
   ↓
handleSendMessage()
   ↓
client.sendMessage() → OpenCode Server
   ↓
SSE Events ← OpenCode Server
   ↓
handleSSEEvent()
   ↓
setMessageStore() → Update Reactive Store
   ↓
currentMessages() memo recomputes
   ↓
MessageList re-renders
   ↓
UI updates
```

---

## Internationalization (i18n)

CodeMux supports multiple languages using `@solid-primitives/i18n`.

### Architecture

#### Translation Files (`src/locales/`)

- **`en.ts`**: English translations with `LocaleDict` interface definition
- **`zh-CN.ts`**: Simplified Chinese translations implementing `LocaleDict`

Translation structure:

```typescript
export interface LocaleDict {
  common: {
    loading: string;
    cancel: string;
    save: string;
    // ...
  };
  login: { /* ... */ };
  chat: { /* ... */ };
  settings: { /* ... */ };
  // ... more sections
}
```

#### i18n Provider (`src/lib/i18n.tsx`)

Core functionality:

1. **`I18nProvider` Component**: Wraps the entire app (in `App.tsx`)
2. **`useI18n()` Hook**: Returns `{ locale, setLocale, t }`
3. **`formatMessage()` Helper**: String interpolation with variables
4. **Auto-detection**: Detects browser language on first load
5. **Persistence**: Saves language preference to `localStorage`

### Usage in Components

#### Basic Usage

```typescript
import { useI18n } from "../lib/i18n";

function MyComponent() {
  const { t, locale, setLocale } = useI18n();
  
  return (
    <div>
      <h1>{t().login.title}</h1>
      <p>{t().chat.startConversation}</p>
    </div>
  );
}
```

#### String Interpolation

```typescript
import { useI18n, formatMessage } from "../lib/i18n";

function TimeDisplay() {
  const { t } = useI18n();
  const minutes = 5;
  
  // Translation: "minutesAgo": "{count} minutes ago"
  return <span>{formatMessage(t().sidebar.minutesAgo, { count: minutes })}</span>;
  // Output: "5 minutes ago" or "5 分钟前"
}
```

#### Language Switcher

The `LanguageSwitcher` component provides a dropdown for language selection:

```typescript
import { LanguageSwitcher } from "../components/LanguageSwitcher";

// Use in any page/component
<LanguageSwitcher />
```

### Adding a New Language

1. **Create translation file** `src/locales/[locale-code].ts`:

```typescript
import type { LocaleDict } from "./en";

export const translations: LocaleDict = {
  common: {
    loading: "Chargement...",
    // ... translate all keys
  },
  // ... all sections must be translated
};
```

2. **Update `i18n.tsx`**:

```typescript
import { translations as frTranslations } from "../locales/fr";

const dictionaries = {
  en: enTranslations,
  "zh-CN": zhCNTranslations,
  fr: frTranslations, // Add new language
};

export const localeNames: Record<LocaleCode, string> = {
  en: "English",
  "zh-CN": "简体中文",
  fr: "Français", // Add display name
};

export type LocaleCode = "en" | "zh-CN" | "fr"; // Add to type
```

3. **Update `LanguageSwitcher.tsx`**:

```typescript
const locales: LocaleCode[] = ["en", "zh-CN", "fr"]; // Add new language
```

### Adding New Translation Keys

1. **Add to `LocaleDict` interface** in `src/locales/en.ts`:

```typescript
export interface LocaleDict {
  // ... existing sections
  newSection: {
    newKey: string;
    anotherKey: string;
  };
}
```

2. **Add translations** in all language files (`en.ts`, `zh-CN.ts`, etc.):

```typescript
export const translations: LocaleDict = {
  // ... existing translations
  newSection: {
    newKey: "English text",
    anotherKey: "More English text",
  },
};
```

3. **Use in components**:

```typescript
const { t } = useI18n();
return <p>{t().newSection.newKey}</p>;
```

### Best Practices

1. **Never hardcode strings**: Always use `t()` for user-facing text
2. **Keep translations in sync**: When adding keys, update all language files
3. **Use meaningful keys**: Key names should indicate usage (e.g., `loginButton`, not `btn1`)
4. **Organize by feature**: Group related translations under the same section
5. **Use interpolation**: For dynamic text, use `formatMessage()` with variables
6. **Test both languages**: Verify UI works correctly in all supported languages

### Common Pitfalls

❌ **Wrong**: Hardcoded strings
```typescript
<button>Save Changes</button>
```

✅ **Correct**: Using i18n
```typescript
const { t } = useI18n();
<button>{t().settings.save}</button>
```

❌ **Wrong**: String concatenation
```typescript
<span>{count + " minutes ago"}</span>
```

✅ **Correct**: Using formatMessage
```typescript
<span>{formatMessage(t().sidebar.minutesAgo, { count })}</span>
```

---

## Common Development Tasks

### Adding a New Message Type

1. **Add type definition in `src/types/opencode.ts`**:

```typescript
export namespace MessageV2 {
  export type Part =
    | ExistingTypes
    | {
        id: string;
        messageID: string;
        sessionID: string;
        type: "your-new-type";
        // ... other fields
      };
}
```

2. **Add rendering logic in `src/components/share/part.tsx`**:

```typescript
if (props.part.type === "your-new-type") {
  return <YourNewContentComponent part={props.part} />;
}
```

3. **Create content renderer component** `src/components/share/content-your-new-type.tsx`

### Adding a New API Endpoint

Add method in `src/lib/opencode-client.ts`:

```typescript
async yourNewMethod(param: string) {
  return this.request<ResponseType>("/your-endpoint", {
    method: "POST",
    body: JSON.stringify({ param }),
  });
}
```

### Adding a New SSE Event Type

Add in `connectSSE`'s `onmessage` handler:

```typescript
if (eventType === "your.new.event" && properties.yourData) {
  onEvent({ type: "your.new.event", data: properties.yourData });
}
```

Then handle in `Chat.tsx`'s `handleSSEEvent`:

```typescript
if (event.type === "your.new.event") {
  // Handle event
}
```

---

## Debugging Tips

### View SSE Event Stream

All SSE events output detailed logs to console:

- `[SSE Client]` prefix: Raw data received by client
- `[SSE]` prefix: Parsed events passed to application

### View Message Loading Process

- `[Init]`: Initialize sessions and messages
- `[LoadMessages]`: Load session messages
- `[SelectSession]`: Switch sessions
- `[NewSession]`: Create new session
- `[DeleteSession]`: Delete session

### View Reactive Updates

- `[currentMessages]`: Output each time current message list is computed

### Common Issue Troubleshooting

#### Messages Not Displaying

1. Check if `currentMessages()` uses `createMemo` (required for reactive tracking)
2. Check if message data is correctly stored in store
3. Check if message's `parts` array is empty
4. Check if `MessageList` filtering logic filtered out messages

#### SSE Connection Failed

1. Check if OpenCode server is running on port 4096
2. Check if Vite proxy configuration is correct
3. View EventSource connection status in browser Network panel

#### Type Errors

1. Ensure using `messageID` and `sessionID` (uppercase ID)
2. Ensure message object contains complete `MessageV2.Info` structure
3. Use `bunx tsc --noEmit` to check type errors

---

## Code Style Guide

### TypeScript

- Prefer `interface` for object types
- Use `type` for union types
- Avoid `any`, use `unknown` when necessary

### SolidJS

- Use `createSignal` for simple state
- Use `createStore` for complex nested state
- Use `createMemo` to cache computed values (ensures reactive tracking)
- Use `createEffect` for side effects
- Use `Show` component instead of ternary expressions

### Components

- Use function components
- Define Props with interface
- Prefer controlled components
- Event handler naming: `handle*` (e.g., `handleClick`)

### File Naming

- Components: PascalCase (e.g., `SessionSidebar.tsx`)
- Utils/Libs: camelCase (e.g., `opencode-client.ts`)
- Types: camelCase (e.g., `opencode.ts`)

---

## Testing and Building

### Development Mode

```bash
bun run start
```

- Start Vite dev server (localhost:5174)
- Start OpenCode server (localhost:4096)
- Generate and display access code

### Build Production Version

```bash
bun run build
```

- Output to `dist/` directory
- Use Vite for optimization and bundling

### Type Checking

```bash
bunx tsc --noEmit
```

---

## Future Improvements

### Feature Enhancements

- [ ] Session renaming
- [ ] Search historical messages
- [ ] Export session as Markdown
- [ ] Multi-user support (multiple tokens)
- [ ] Dark mode toggle
- [ ] Message editing and deletion
- [ ] File upload support

### Performance Optimization

- [ ] Virtual scrolling (long message lists)
- [ ] Paginated message loading
- [ ] Lazy-load code highlighters
- [ ] Service Worker caching

### User Experience

- [ ] Keyboard shortcuts
- [ ] Drag-and-drop file upload
- [ ] Full-text message search
- [ ] Session archiving
- [ ] Message quote reply

---

## Common Pitfalls

### 1. Inconsistent Field Naming

❌ **Wrong**:

```typescript
const messageId = part.messageId; // lowercase id
```

✅ **Correct**:

```typescript
const messageId = part.messageID; // uppercase ID
```

### 2. Not Using createMemo

❌ **Wrong**:

```typescript
const currentMessages = () => {
  return Object.values(messageStore.bySession[sessionId]);
};
```

✅ **Correct**:

```typescript
const currentMessages = createMemo(() => {
  return Object.values(messageStore.bySession[sessionId]);
});
```

### 3. Incomplete Message Structure

❌ **Wrong**:

```typescript
messagesMap[msgInfo.id] = {
  id: msgInfo.id,
  role: msgInfo.role,
  parts: msgParts,
};
```

✅ **Correct**:

```typescript
messagesMap[msgInfo.id] = {
  ...msgInfo, // Preserve all original fields
  parts: msgParts,
};
```

### 4. Wrong SSE Event Format

❌ **Wrong**:

```typescript
onEvent({ type: parsed.key, data: parsed.content });
```

✅ **Correct**:

```typescript
const eventType = parsed.payload.type;
const properties = parsed.payload.properties;
onEvent({ type: eventType, data: properties.part });
```

---

## Dependencies

### Core Dependencies

- `solid-js`: ^1.9.3 - SolidJS framework
- `@solidjs/router`: ^0.14.12 - Router management
- `vite-plugin-solid`: ^2.10.2 - Vite SolidJS plugin

### UI and Styling

- `tailwindcss`: ^3.4.0 - CSS framework
- `autoprefixer`: ^10.4.20 - CSS prefixing
- `postcss`: ^8.4.49 - CSS processing

### Message Rendering

- `marked`: ^15.0.4 - Markdown parsing
- `shiki`: ^1.24.2 - Code highlighting
- `diff`: ^7.0.0 - Code diff display
- `luxon`: ^3.5.0 - Date/time handling
- `lang-map`: ^0.4.0 - Language mapping

---

## Quick Reference

### Start Project

```bash
cd /Users/duang/workspace/codemux
bun install
bun run start
```

### Access Application

1. Open browser to `http://localhost:5174`
2. Enter 6-digit access code displayed in console
3. Start using

### Important File Paths

- API Client: `src/lib/opencode-client.ts`
- Main Interface: `src/pages/Chat.tsx`
- State Management: `src/stores/*.ts`
- Type Definitions: `src/types/opencode.ts`
- Startup Script: `scripts/start.ts`

### Debug Commands

```bash
# Check TypeScript errors
bunx tsc --noEmit

# Build check
bun run build

# Start frontend only (manually start OpenCode)
bun run dev
```

---

**Last Updated**: 2026-01-13
**Project Version**: 1.0.0
**OpenCode Compatible Version**: 1.1.15+
