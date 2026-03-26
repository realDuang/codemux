// Define the structure of our translations
export interface LocaleDict {
  // Common
  common: {
    loading: string;
    cancel: string;
    save: string;
    delete: string;
    confirm: string;
    back: string;
    copied: string;
    showMore: string;
    showLess: string;
    showResults: string;
    hideResults: string;
    showDetails: string;
    hideDetails: string;
    showPreview: string;
    hidePreview: string;
    showContents: string;
    hideContents: string;
    showOutput: string;
    hideOutput: string;
    error: string;
    unknownProject: string;
    running: string;
  };

  // Permission
  permission: {
    deny: string;
    allowOnce: string;
    allowAlways: string;
    waitingApproval: string;
  };
  // Question
  question: {
    submit: string;
    dismiss: string;
    customPlaceholder: string;
    waitingAnswer: string;
    selectMultiple: string;
    back: string;
    next: string;
  };

  // Login page
  login: {
    title: string;
    accessCode: string;
    placeholder: string;
    invalidCode: string;
    errorOccurred: string;
    verifying: string;
    connect: string;
    checkingDevice: string;
    rememberDevice: string;
  };

  // Chat page
  chat: {
    newSession: string;
    remoteAccess: string;
    settings: string;
    logout: string;
    startConversation: string;
    startConversationDesc: string;
    noSessionSelected: string;
    noSessionSelectedDesc: string;
    initFailed: string;
    retry: string;
    disclaimer: string;
    noModeError: string;
    noModelError: string;
    queued: string;
    disconnected: string;
  };

  // Settings page
  settings: {
    back: string;
    title: string;
    general: string;
    language: string;
    languageDesc: string;
    theme: string;
    themeDesc: string;
    themeLight: string;
    themeDark: string;
    themeSystem: string;
    security: string;
    devicesDesc: string;
    logging: string;
    logFilePath: string;
    logFilePathDesc: string;
    openLogFolder: string;
    conversationsPath: string;
    conversationsPathDesc: string;
    openConversationsFolder: string;
    logLevel: string;
    logLevelDesc: string;
    importHistory: string;
    importHistoryDesc: string;
    importPreview: string;
    importExecute: string;
    importLast10: string;
    importLast50: string;
    importLast100: string;
    importAll: string;
    importAlreadyImported: string;
    importWillReimport: string;
    importProgress: string;
    importComplete: string;
    importCompleteDesc: string;
    importNoSessions: string;
    importError: string;
    importSkipped: string;
    showDefaultWorkspace: string;
    showDefaultWorkspaceDesc: string;
  };

  // Remote Access page
  remote: {
    title: string;
    publicAccess: string;
    publicAccessDesc: string;
    starting: string;
    startFailed: string;
    securityWarning: string;
    securityWarningDesc: string;
    accessPassword: string;
    connectionAddress: string;
    publicAddress: string;
    lanAddress: string;
    localAddress: string;
    lan: string;
    public: string;
    notConnected: string;
    publicQrScan: string;
    lanQrScan: string;
    publicQrDesc: string;
    lanQrDesc: string;
    webApp: string;
    devicesDesc: string;
    publicAccessTab: string;
    publicAccessTabDesc: string;
    tunnelRunning: string;
    tunnelStopped: string;
    noteUrlChanges: string;
    noteUrlChangesDesc: string;
    noteUrlFixedDomain: string;
    namedTunnel: string;
    namedTunnelDesc: string;
    tunnelHostname: string;
    tunnelHostnamePlaceholder: string;
    namedTunnelActive: string;
    namedTunnelSetupHint: string;
    noteSecurity: string;
    noteSecurityDesc: string;
    noteKeepRunning: string;
    noteKeepRunningDesc: string;
    notes: string;
    publicAccessEnabled: string;
    publicAccessDisabled: string;
    goToPublicAccess: string;
  };

  // Session Sidebar
  sidebar: {
    noSessions: string;
    loadingSessions: string;
    newSession: string;
    deleteConfirm: string;
    deleteSession: string;
    renameSession: string;
    justNow: string;
    minutesAgo: string;
    hoursAgo: string;
    daysAgo: string;
    files: string;
    openStorageFolder: string;
    openInFileExplorer: string;
    copySessionId: string;
    expandSidebar: string;
    collapseSidebar: string;
    sessions: string;
    refreshSessions: string;
    defaultEngine: string;
    searchPlaceholder: string;
    noSearchResults: string;
    defaultWorkspace: string;
    projectsTitle: string;
  };

  // Project
  project: {
    add: string;
    addTitle: string;
    inputPath: string;
    pathHint: string;
    browse: string;
    browseNotSupported: string;
    adding: string;
    addFailed: string;
    hideTitle: string;
    hideConfirm: string;
    sessionCount: string;
    hideWarning: string;
    hideNote: string;
  };

  // Prompt Input
  prompt: {
    buildMode: string;
    build: string;
    planMode: string;
    plan: string;
    readOnly: string;
    placeholder: string;
    planPlaceholder: string;
    buildPlaceholder: string;
    autopilotPlaceholder: string;
    send: string;
    typeNextMessage: string;
    waitingForResponse: string;
    attachImage: string;
    imageTooLarge: string;
    imageUnsupportedType: string;
    imageLimitReached: string;
    removeImage: string;
  };

  // Message Parts
  parts: {
    linkToMessage: string;
    thinking: string;
    attachment: string;
    creatingPlan: string;
    updatingPlan: string;
    completingPlan: string;
    todoTitle: string;
    match: string;
    matches: string;
    result: string;
    results: string;
    lines: string;
    toolHint: string;
  };

  // Steps (SessionTurn)
  steps: {
    showSteps: string;
    hideSteps: string;
    response: string;
    consideringNextSteps: string;
    delegatingWork: string;
    planningNextSteps: string;
    gatheringContext: string;
    gatheredContext: string;
    searchingCodebase: string;
    searchingWeb: string;
    makingEdits: string;
    runningCommands: string;
    gatheringThoughts: string;
    organizingContext: string;
    contextOrganized: string;
    cancelled: string;
    errorOccurred: string;
    continueWork: string;
    loadingSteps: string;
  };

  // Devices page
  devices: {
    title: string;
    currentDevice: string;
    hostDevice: string;
    lastSeen: string;
    firstLogin: string;
    rename: string;
    revoke: string;
    revokeConfirm: string;
    revokeOthers: string;
    revokeOthersConfirm: string;
    revokeOthersSuccess: string;
    noOtherDevices: string;
    securityTip: string;
    justNow: string;
    minutesAgo: string;
    hoursAgo: string;
    daysAgo: string;
    renameDevice: string;
    renameDevicePlaceholder: string;
    deviceRevoked: string;
  };

  // Entry page
  entry: {
    checkingAccess: string;
    enterChat: string;
    enterChatDesc: string;
    localModeTitle: string;
    localModeDesc: string;
    startingServices: string;
  };

  // Device approval
  approval: {
    waitingTitle: string;
    waitingDesc: string;
    waitingHint: string;
    denied: string;
    deniedDesc: string;
    expired: string;
    expiredDesc: string;
    tryAgain: string;
    newRequest: string;
    newRequestTitle: string;
    deviceName: string;
    platform: string;
    browser: string;
    ipAddress: string;
    approve: string;
    deny: string;
    pendingRequests: string;
    noPendingRequests: string;
    requestApproved: string;
    requestDenied: string;
  };

  // Engine
  engine: {
    title: string;
    engines: string;
    status: string;
    running: string;
    stopped: string;
    starting: string;
    error: string;
    notAuthenticated: string;
    version: string;
    selectEngine: string;
    defaultEngine: string;
    noEngines: string;
    defaultModel: string;
    defaultModelDesc: string;
    noModelsAvailable: string;
    modelInputPlaceholder: string;
    enabled: string;
    disabled: string;
    unavailable: string;
  };

  // Channels
  channel: {
    channels: string;
    feishuBot: string;
    feishuBotDesc: string;
    dingtalkBot: string;
    dingtalkBotDesc: string;
    telegramBot: string;
    telegramBotDesc: string;
    wecomBot: string;
    wecomBotDesc: string;
    teamsBot: string;
    teamsBotDesc: string;
    appId: string;
    appIdPlaceholder: string;
    appSecret: string;
    appSecretPlaceholder: string;
    appKey: string;
    appKeyPlaceholder: string;
    robotCode: string;
    robotCodePlaceholder: string;
    botToken: string;
    botTokenPlaceholder: string;
    webhookUrl: string;
    webhookUrlPlaceholder: string;
    corpId: string;
    corpIdPlaceholder: string;
    corpSecret: string;
    corpSecretPlaceholder: string;
    agentId: string;
    agentIdPlaceholder: string;
    callbackToken: string;
    callbackTokenPlaceholder: string;
    callbackEncodingAESKey: string;
    callbackEncodingAESKeyPlaceholder: string;
    microsoftAppId: string;
    microsoftAppIdPlaceholder: string;
    microsoftAppPassword: string;
    microsoftAppPasswordPlaceholder: string;
    tenantId: string;
    tenantIdPlaceholder: string;
    enable: string;
    disable: string;
    status: string;
    connected: string;
    disconnected: string;
    connecting: string;
    error: string;
    autoApprove: string;
    autoApproveDesc: string;
    advanced: string;
    streamingThrottle: string;
    streamingThrottleDesc: string;
    ms: string;
    configure: string;
    configRequired: string;
    save: string;
    saving: string;
    directConnect: string;
    directConnectBadge: string;
    webhookConnect: string;
    webhookConnectBadge: string;
    tunnelRequired: string;
    tunnelRequiredDesc: string;
    teamsWebhookGuide: string;
    wecomWebhookGuide: string;
    webhookEndpoint: string;
    teamsInstallHint: string;
  };

  // Token Usage
  tokenUsage: {
    tokens: string;
    input: string;
    output: string;
    cache: string;
    cost: string;
    cacheReadWrite: string;
    sessionSummary: string;
    premiumRequest: string;
    premiumRequests: string;
  };

  // Update
  update: {
    title: string;
    currentVersion: string;
    checkForUpdates: string;
    checking: string;
    upToDate: string;
    available: string;
    downloading: string;
    downloaded: string;
    restartNow: string;
    restartLater: string;
    error: string;
    codeSignError: string;
    manualDownload: string;
    autoCheck: string;
    autoCheckDesc: string;
    launchAtLogin: string;
    launchAtLoginDesc: string;
    releaseNotes: string;
    retry: string;
  };

  // Notifications
  notification: {
    messageSendFailed: string;
    sessionCreateFailed: string;
    sessionDeleteFailed: string;
    gatewayDisconnected: string;
    gatewayReconnected: string;
    engineError: string;
  };

  // File Explorer
  fileExplorer: {
    togglePanel: string;
    allFiles: string;
    changes: string;
    changesCount: string;
    content: string;
    diff: string;
    noProject: string;
    noChanges: string;
    noDiff: string;
    binaryFile: string;
    selectFileToPreview: string;
    fileTooLarge: string;
    searchPlaceholder: string;
    closeTab: string;
    linesAdded: string;
    linesRemoved: string;
    imageZoomIn: string;
    imageZoomOut: string;
    imageFitToWindow: string;
    imageResetZoom: string;
    searchInFile: string;
    searchNext: string;
    searchPrev: string;
    searchClose: string;
    noResults: string;
    matchCount: string;
    openInExplorer: string;
  };

  // Scheduled Tasks
  scheduledTask: {
    title: string;
    create: string;
    edit: string;
    delete: string;
    deleteConfirm: string;
    save: string;
    runNow: string;
    taskFired: string;
    taskFailed: string;
    name: string;
    namePlaceholder: string;
    description: string;
    descriptionPlaceholder: string;
    prompt: string;
    promptPlaceholder: string;
    engineType: string;
    directory: string;
    frequency: string;
    frequencyManual: string;
    frequencyInterval: string;
    frequencyDaily: string;
    frequencyWeekly: string;
    intervalLabel: string;
    interval5m: string;
    interval10m: string;
    interval30m: string;
    interval1h: string;
    interval2h: string;
    interval6h: string;
    interval12h: string;
    time: string;
    dayOfWeek: string;
    days: string[];
    daysShort: string[];
    enabled: string;
    disabled: string;
    enable: string;
    disable: string;
    nextRun: string;
    lastRun: string;
    never: string;
    manual: string;
    noTasks: string;
    runHistory: string;
  };
}

export const en: LocaleDict = {
  // Common
  common: {
    loading: "Loading...",
    cancel: "Cancel",
    save: "Save",
    delete: "Delete",
    confirm: "Confirm",
    back: "Back",
    copied: "Copied!",
    showMore: "Show more",
    showLess: "Show less",
    showResults: "Show results",
    hideResults: "Hide results",
    showDetails: "Show details",
    hideDetails: "Hide details",
    showPreview: "Show preview",
    hidePreview: "Hide preview",
    showContents: "Show contents",
    hideContents: "Hide contents",
    showOutput: "Show output",
    hideOutput: "Hide output",
    error: "Error",
    unknownProject: "Unknown Project",
    running: "Running...",
  },

  // Permission
  permission: {
    deny: "Deny",
    allowOnce: "Allow once",
    allowAlways: "Allow always",
    waitingApproval: "Waiting for approval",
  },
  // Question
  question: {
    submit: "Submit",
    dismiss: "Dismiss",
    customPlaceholder: "Type a custom answer...",
    waitingAnswer: "Waiting for answer",
    selectMultiple: "Select multiple options",
    back: "Back",
    next: "Next",
  },

  // Login page
  login: {
    title: "CodeMux",
    accessCode: "Access Code",
    placeholder: "Enter 6-digit code",
    invalidCode: "Invalid access code",
    errorOccurred: "An error occurred. Please try again.",
    verifying: "Verifying...",
    connect: "Connect",
    checkingDevice: "Checking device...",
    rememberDevice: "This device will be remembered for future access",
  },

  // Chat page
  chat: {
    newSession: "New Session",
    remoteAccess: "Remote Access",
    settings: "Settings",
    logout: "Logout",
    startConversation: "Start a new conversation",
    startConversationDesc: "Select a model and type any question in the input box below to start chatting.",
    noSessionSelected: "No session selected",
    noSessionSelectedDesc: "Select a session from the sidebar or create a new one to get started.",
    initFailed: "Initialization Failed",
    retry: "Retry",
    disclaimer: "AI-generated content may be inaccurate. Please verify important information.",
    noModeError: "No mode selected. Please select a mode before sending.",
    noModelError: "No model configured. Please set a model in Settings > Engines.",
    queued: "Queued",
    disconnected: "Disconnected",
  },

  // Settings page
  settings: {
    back: "Back",
    title: "Settings",
    general: "General",
    language: "Language",
    languageDesc: "Choose your preferred interface language",
    theme: "Theme",
    themeDesc: "Choose your preferred color theme",
    themeLight: "Light",
    themeDark: "Dark",
    themeSystem: "System",
    security: "Security",
    devicesDesc: "Manage devices that can access this server",
    logging: "Logging",
    logFilePath: "Log File Location",
    logFilePathDesc: "Where application logs are stored on disk",
    openLogFolder: "Open Folder",
    conversationsPath: "Conversations Storage",
    conversationsPathDesc: "Where conversation history and messages are stored on disk",
    openConversationsFolder: "Open Folder",
    logLevel: "Log Level",
    logLevelDesc: "Minimum severity level for writing logs to file",
    importHistory: "Import History",
    importHistoryDesc: "Import historical sessions from this engine into CodeMux",
    importPreview: "Preview",
    importExecute: "Import Selected",
    importLast10: "Last 10",
    importLast50: "Last 50",
    importLast100: "Last 100",
    importAll: "All",
    importAlreadyImported: "Already imported",
    importWillReimport: "Will reimport",
    importProgress: "Importing {completed}/{total}: {title}",
    importComplete: "Import Complete",
    importCompleteDesc: "{imported} imported, {skipped} skipped, {errors} errors",
    importNoSessions: "No new sessions found to import",
    importError: "Failed to import",
    importSkipped: "Skipped (already imported)",
    showDefaultWorkspace: "Show default workspace in sidebar",
    showDefaultWorkspaceDesc: "Display the default workspace project group in the sidebar",
  },

  // Remote Access page
  remote: {
    title: "Remote Access",
    publicAccess: "Public Remote Access",
    publicAccessDesc: "Access via Cloudflare tunnel from the internet",
    starting: "Starting tunnel, please wait...",
    startFailed: "Failed to start. Please ensure cloudflared is installed",
    securityWarning: "Security Warning:",
    securityWarningDesc: "Remote access allows full control of this device. Keep your access password safe and never share it with untrusted people.",
    accessPassword: "Access Password",
    connectionAddress: "Connection Address",
    publicAddress: "Public Address",
    lanAddress: "LAN Address",
    localAddress: "Local Address",
    lan: "LAN",
    public: "Public",
    notConnected: "Not Connected",
    publicQrScan: "Scan to access via public network",
    lanQrScan: "Scan to access via LAN",
    publicQrDesc: "Suitable for remote connections, may be slower",
    lanQrDesc: "Make sure your phone and computer are on the same Wi-Fi",
    webApp: "Web App",
    devicesDesc: "Manage devices that can access this server",
    publicAccessTab: "Public Access",
    publicAccessTabDesc: "Expose local services to the internet via Cloudflare Tunnel for remote web access and webhook-based channel messaging",
    tunnelRunning: "Running",
    tunnelStopped: "Not Running",
    noteUrlChanges: "URL Changes on Restart",
    noteUrlChangesDesc: "Free tunnel URLs change on each restart. Webhook channels will need their platform callback URLs reconfigured. Configure a Named Tunnel above for a fixed domain.",
    noteUrlFixedDomain: "Named Tunnel configured — your domain stays the same across restarts.",
    namedTunnel: "Named Tunnel (Fixed Domain)",
    namedTunnelDesc: "Use a Cloudflare Named Tunnel for a fixed domain that won't change on restart. Free with any Cloudflare-managed domain.",
    tunnelHostname: "Domain (Optional)",
    tunnelHostnamePlaceholder: "e.g. codemux.example.com",
    namedTunnelActive: "Named Tunnel active — domain is fixed across restarts",
    namedTunnelSetupHint: "Run `cloudflared tunnel login`, `cloudflared tunnel create <name>` and `cloudflared tunnel route dns <name> <domain>` first.",
    noteSecurity: "Access Security",
    noteSecurityDesc: "Web access requires a 6-digit password. Webhook endpoints are validated by each channel's SDK signature/token verification.",
    noteKeepRunning: "Keep App Running",
    noteKeepRunningDesc: "The tunnel depends on the local CodeMux process. Closing the app or sleeping the machine will interrupt public access.",
    notes: "Notes",
    publicAccessEnabled: "Public Access enabled — Cloudflare Tunnel running",
    publicAccessDisabled: "Public Access not enabled — go to enable Tunnel",
    goToPublicAccess: "Go to Public Access",
  },

  // Session Sidebar
  sidebar: {
    noSessions: "No sessions",
    loadingSessions: "Loading sessions...",
    newSession: "New session",
    deleteConfirm: "Are you sure you want to delete this session?",
    deleteSession: "Delete session",
    renameSession: "Rename session",
    justNow: "just now",
    minutesAgo: "{count} min ago",
    hoursAgo: "{count}h ago",
    daysAgo: "{count}d ago",
    files: "{count} files",
    openStorageFolder: "Open storage folder",
    openInFileExplorer: "Open in file explorer",
    copySessionId: "Copy session ID",
    expandSidebar: "Expand sidebar",
    collapseSidebar: "Collapse sidebar",
    sessions: "Sessions",
    refreshSessions: "Refresh sessions",
    defaultEngine: "Default Engine",
    searchPlaceholder: "Search sessions...",
    noSearchResults: "No matching sessions",
    defaultWorkspace: "Default Workspace",
    projectsTitle: "Projects",
  },

  // Project
  project: {
    add: "Add Project",
    addTitle: "Add Project",
    inputPath: "Enter project path",
    pathHint: "Enter an absolute path to a git repository on the server",
    browse: "Browse",
    browseNotSupported: "Folder selection not supported in this browser",
    adding: "Adding project...",
    addFailed: "Failed to add project",
    hideTitle: "Delete Project Sessions",
    hideConfirm: "Delete all sessions for project \"{name}\"?",
    sessionCount: "This will delete {count} session(s).",
    hideWarning: "Session history will be permanently deleted.",
    hideNote: "The project will reappear when new sessions are created.",
  },

  // Prompt Input
  prompt: {
    buildMode: "Build mode - execute code changes and commands",
    build: "Build",
    planMode: "Plan mode - read-only research and planning",
    plan: "Plan",
    readOnly: "Read-only",
    placeholder: "Type a message...",
    planPlaceholder: "Describe what you want to plan or analyze...",
    buildPlaceholder: "Describe what you want to build or change...",
    autopilotPlaceholder: "Describe a task to run autonomously...",
    send: "Send message",
    typeNextMessage: "Type your next message...",
    waitingForResponse: "Waiting for response...",
    attachImage: "Attach image",
    imageTooLarge: "Image too large (max 3MB)",
    imageUnsupportedType: "Unsupported image type",
    imageLimitReached: "Maximum 4 images per message",
    removeImage: "Remove image",
  },

  // Message Parts
  parts: {
    linkToMessage: "Link to this message",
    thinking: "Thinking",
    attachment: "Attachment",
    creatingPlan: "Creating plan",
    updatingPlan: "Updating plan",
    completingPlan: "Completing plan",
    todoTitle: "Tasks",
    match: "{count} match",
    matches: "{count} matches",
    result: "{count} result",
    results: "{count} results",
    lines: "{count} lines",
    toolHint: "Hint",
  },

  // Steps (SessionTurn)
  steps: {
    showSteps: "Show steps",
    hideSteps: "Hide steps",
    response: "Response",
    consideringNextSteps: "Considering next steps",
    delegatingWork: "Delegating work",
    planningNextSteps: "Planning next steps",
    gatheringContext: "Gathering context",
    gatheredContext: "Gathered context",
    searchingCodebase: "Searching the codebase",
    searchingWeb: "Searching the web",
    makingEdits: "Making edits",
    runningCommands: "Running commands",
    gatheringThoughts: "Gathering thoughts",
    organizingContext: "Organizing context",
    contextOrganized: "Context organized",
    cancelled: "Cancelled",
    errorOccurred: "Error",
    continueWork: "Continue",
    loadingSteps: "Loading steps...",
  },

  // Devices page
  devices: {
    title: "Authorized Devices",
    currentDevice: "Current device",
    hostDevice: "Host",
    lastSeen: "Last seen",
    firstLogin: "First login",
    rename: "Rename",
    revoke: "Revoke",
    revokeConfirm: "Are you sure you want to revoke access for this device?",
    revokeOthers: "Revoke all other devices",
    revokeOthersConfirm: "Are you sure you want to revoke access for all other devices?",
    revokeOthersSuccess: "{count} device(s) revoked",
    noOtherDevices: "No other authorized devices",
    securityTip: "If you see an unfamiliar device, revoke its access immediately",
    justNow: "just now",
    minutesAgo: "{count} min ago",
    hoursAgo: "{count}h ago",
    daysAgo: "{count}d ago",
    renameDevice: "Rename device",
    renameDevicePlaceholder: "Enter device name",
    deviceRevoked: "Device access revoked",
  },

  // Entry page
  entry: {
    checkingAccess: "Checking access...",
    enterChat: "Enter Chat",
    enterChatDesc: "Start using CodeMux AI assistant",
    localModeTitle: "Local Access Mode",
    localModeDesc: "You're accessing from localhost. Configure remote access below or enter chat directly.",
    startingServices: "Starting services...",
  },

  // Device approval
  approval: {
    waitingTitle: "Waiting for Approval",
    waitingDesc: "Your request has been sent to the host device",
    waitingHint: "Please wait for the host to approve your connection",
    denied: "Access Denied",
    deniedDesc: "The host has denied your connection request",
    expired: "Request Expired",
    expiredDesc: "Your request has expired. Please try again.",
    tryAgain: "Try Again",
    newRequest: "New Device Request",
    newRequestTitle: "A device is requesting access",
    deviceName: "Device",
    platform: "Platform",
    browser: "Browser",
    ipAddress: "IP Address",
    approve: "Approve",
    deny: "Deny",
    pendingRequests: "Pending Requests",
    noPendingRequests: "No pending requests",
    requestApproved: "Request approved",
    requestDenied: "Request denied",
  },

  // Engine
  engine: {
    title: "Engines",
    engines: "Engines",
    status: "Status",
    running: "Running",
    stopped: "Stopped",
    starting: "Starting...",
    error: "Error",
    notAuthenticated: "Not Authenticated",
    version: "Version",
    selectEngine: "Select Engine",
    defaultEngine: "Default Engine",
    noEngines: "No engines available",
    defaultModel: "Model",
    defaultModelDesc: "Model used for conversations",
    noModelsAvailable: "No models available",
    modelInputPlaceholder: "Enter model ID (e.g. claude-sonnet-4-20250514)",
    enabled: "Enabled",
    disabled: "Disabled",
    unavailable: "Unavailable",
  },
  channel: {
    channels: "Channels",
    feishuBot: "Feishu Bot",
    feishuBotDesc: "Connect to Feishu (Lark) to use CodeMux via bot messages",
    dingtalkBot: "DingTalk Bot",
    dingtalkBotDesc: "Connect to DingTalk to use CodeMux via robot messages",
    telegramBot: "Telegram Bot",
    telegramBotDesc: "Connect to Telegram to use CodeMux via bot messages",
    wecomBot: "WeCom Bot",
    wecomBotDesc: "Connect to WeCom (WeChat Work) to use CodeMux via app messages",
    teamsBot: "Teams Bot",
    teamsBotDesc: "Connect to Microsoft Teams to use CodeMux via bot messages",
    appId: "App ID",
    appIdPlaceholder: "Enter Feishu App ID",
    appSecret: "App Secret",
    appSecretPlaceholder: "Enter Feishu App Secret",
    appKey: "App Key",
    appKeyPlaceholder: "Enter DingTalk App Key",
    robotCode: "Robot Code",
    robotCodePlaceholder: "Enter DingTalk Robot Code",
    botToken: "Bot Token",
    botTokenPlaceholder: "Enter Telegram Bot Token from @BotFather",
    webhookUrl: "Webhook URL",
    webhookUrlPlaceholder: "HTTPS URL for webhook (optional)",
    corpId: "Corp ID",
    corpIdPlaceholder: "Enter WeCom Corp ID",
    corpSecret: "Corp Secret",
    corpSecretPlaceholder: "Enter WeCom App Secret",
    agentId: "Agent ID",
    agentIdPlaceholder: "Enter WeCom Agent ID",
    callbackToken: "Callback Token",
    callbackTokenPlaceholder: "Enter WeCom callback verification Token",
    callbackEncodingAESKey: "Encoding AES Key",
    callbackEncodingAESKeyPlaceholder: "Enter WeCom callback EncodingAESKey (43 chars)",
    microsoftAppId: "Microsoft App ID",
    microsoftAppIdPlaceholder: "Enter Azure AD App Registration Client ID",
    microsoftAppPassword: "App Password",
    microsoftAppPasswordPlaceholder: "Enter Azure AD Client Secret",
    tenantId: "Tenant ID",
    tenantIdPlaceholder: "Azure AD Tenant ID (for SingleTenant bots)",
    enable: "Enable",
    disable: "Disable",
    status: "Status",
    connected: "Connected",
    disconnected: "Disconnected",
    connecting: "Connecting...",
    error: "Error",
    autoApprove: "Auto-approve Permissions",
    autoApproveDesc: "Automatically approve engine permission requests",
    advanced: "Advanced Settings",
    streamingThrottle: "Streaming Throttle",
    streamingThrottleDesc: "Minimum interval between Feishu message updates",
    ms: "ms",
    configure: "Configure",
    configRequired: "App ID and App Secret are required to enable the bot",
    save: "Save",
    saving: "Saving...",
    directConnect: "Direct",
    directConnectBadge: "Outbound",
    webhookConnect: "Requires Public Access",
    webhookConnectBadge: "Webhook",
    tunnelRequired: "Public Access not enabled",
    tunnelRequiredDesc: "Go to Public Access tab to enable Tunnel for webhook channels",
    teamsWebhookGuide: "Configure this URL as Messaging Endpoint in Azure Bot Service → Settings",
    wecomWebhookGuide: "Configure this URL as callback URL in WeCom Admin Console → App → Receive Messages",
    webhookEndpoint: "Endpoint",
    teamsInstallHint: "Install the bot in Teams: Apps → Manage your apps → Upload a custom app → select the generated teams-app.zip (in project .channels/ folder or app data directory)",
  },

  // Token Usage
  tokenUsage: {
    tokens: "tokens",
    input: "Input",
    output: "Output",
    cache: "Cache",
    cost: "Cost",
    cacheReadWrite: "{read} read / {write} write",
    sessionSummary: "Session: ↑{input} ↓{output} tokens",
    premiumRequest: "{count} premium request",
    premiumRequests: "{count} premium requests",
  },

  // Update
  update: {
    title: "Update",
    currentVersion: "Current Version",
    checkForUpdates: "Check for Updates",
    checking: "Checking for updates...",
    upToDate: "You're up to date",
    available: "New version v{version} available",
    downloading: "Downloading update...",
    downloaded: "Update ready to install",
    restartNow: "Restart Now",
    restartLater: "Later",
    error: "Update check failed",
    codeSignError: "New version available, please download manually",
    manualDownload: "Download",
    autoCheck: "Auto-check for updates",
    autoCheckDesc: "Automatically check for updates on startup",
    launchAtLogin: "Launch at Login",
    launchAtLoginDesc: "Automatically start CodeMux when you log in to your computer",
    releaseNotes: "What's new",
    retry: "Retry",
  },

  // Notifications
  notification: {
    messageSendFailed: "Failed to send message. Please try again.",
    sessionCreateFailed: "Failed to create session.",
    sessionDeleteFailed: "Failed to delete session.",
    gatewayDisconnected: "Connection lost. Reconnecting...",
    gatewayReconnected: "Connection restored.",
    engineError: "Engine error: {message}",
  },

  // File Explorer
  fileExplorer: {
    togglePanel: "Toggle file explorer",
    allFiles: "Files",
    changes: "Changes",
    changesCount: "{count} changes",
    content: "Content",
    diff: "Diff",
    noProject: "No project directory",
    noChanges: "No changes detected",
    noDiff: "No diff available",
    binaryFile: "Binary file cannot be previewed",
    selectFileToPreview: "Select a file to preview",
    fileTooLarge: "File is too large to preview",
    searchPlaceholder: "Search files...",
    closeTab: "Close tab",
    linesAdded: "+{count}",
    linesRemoved: "-{count}",
    imageZoomIn: "Zoom in",
    imageZoomOut: "Zoom out",
    imageFitToWindow: "Fit to window",
    imageResetZoom: "Reset zoom",
    searchInFile: "Search in file",
    searchNext: "Next match",
    searchPrev: "Previous match",
    searchClose: "Close search",
    noResults: "No results",
    matchCount: "{current} of {total}",
    openInExplorer: "Open in file explorer",
  },

  scheduledTask: {
    title: "Scheduled Tasks",
    create: "Create Task",
    edit: "Edit Task",
    delete: "Delete",
    deleteConfirm: "Delete this scheduled task?",
    save: "Save",
    runNow: "Run Now",
    taskFired: "Scheduled task started",
    taskFailed: "Scheduled task failed",
    name: "Name",
    namePlaceholder: "my-task-name",
    description: "Description",
    descriptionPlaceholder: "Brief description of what this task does",
    prompt: "Prompt",
    promptPlaceholder: "Review pull requests and provide feedback...",
    engineType: "Engine",
    directory: "Project",
    frequency: "Frequency",
    frequencyManual: "Manual",
    frequencyInterval: "Interval",
    frequencyDaily: "Daily",
    frequencyWeekly: "Weekly",
    intervalLabel: "Run every",
    interval5m: "5 min",
    interval10m: "10 min",
    interval30m: "30 min",
    interval1h: "1 hour",
    interval2h: "2 hours",
    interval6h: "6 hours",
    interval12h: "12 hours",
    time: "Time",
    dayOfWeek: "Days",
    days: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    daysShort: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    enabled: "Enabled",
    disabled: "Disabled",
    enable: "Enable",
    disable: "Disable",
    nextRun: "Next run",
    lastRun: "Last run",
    never: "Never",
    manual: "Manual",
    noTasks: "No scheduled tasks",
    runHistory: "Run History",
  },
};
