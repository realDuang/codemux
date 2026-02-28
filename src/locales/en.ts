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
    logLevel: string;
    logLevelDesc: string;
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
    devicesDesc: string;
  };

  // Session Sidebar
  sidebar: {
    noSessions: string;
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
    copySessionId: string;
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
    notGitRepo: string;
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
  };

  // Model Selector
  model: {
    selectModel: string;
    noModels: string;
  };

  // Message Parts
  parts: {
    linkToMessage: string;
    thinking: string;
    attachment: string;
    creatingPlan: string;
    updatingPlan: string;
    completingPlan: string;
    match: string;
    matches: string;
    result: string;
    results: string;
    lines: string;
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
    searchingCodebase: string;
    searchingWeb: string;
    makingEdits: string;
    runningCommands: string;
    gatheringThoughts: string;
    organizingContext: string;
    contextOrganized: string;
    cancelled: string;
    errorOccurred: string;
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
    version: string;
    selectEngine: string;
    defaultEngine: string;
    noEngines: string;
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
    logLevel: "Log Level",
    logLevelDesc: "Minimum severity level for writing logs to file",
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
    devicesDesc: "Manage devices that can access this server",
  },

  // Session Sidebar
  sidebar: {
    noSessions: "No sessions",
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
    copySessionId: "Copy session ID",
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
    notGitRepo: "The specified path is not a valid git repository",
    hideTitle: "Hide Project",
    hideConfirm: "Hide project \"{name}\" and delete all its sessions?",
    sessionCount: "This will delete {count} session(s).",
    hideWarning: "Session history will be permanently deleted.",
    hideNote: "The project can be restored by adding it again with the same path.",
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
  },

  // Model Selector
  model: {
    selectModel: "Select Model",
    noModels: "No models available. Please configure the server first",
  },

  // Message Parts
  parts: {
    linkToMessage: "Link to this message",
    thinking: "Thinking",
    attachment: "Attachment",
    creatingPlan: "Creating plan",
    updatingPlan: "Updating plan",
    completingPlan: "Completing plan",
    match: "{count} match",
    matches: "{count} matches",
    result: "{count} result",
    results: "{count} results",
    lines: "{count} lines",
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
    searchingCodebase: "Searching the codebase",
    searchingWeb: "Searching the web",
    makingEdits: "Making edits",
    runningCommands: "Running commands",
    gatheringThoughts: "Gathering thoughts",
    organizingContext: "Organizing context",
    contextOrganized: "Context organized",
    cancelled: "Cancelled",
    errorOccurred: "Error",
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
    version: "Version",
    selectEngine: "Select Engine",
    defaultEngine: "Default Engine",
    noEngines: "No engines available",
  },
};
