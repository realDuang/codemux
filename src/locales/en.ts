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
    disclaimer: string;
  };

  // Settings page
  settings: {
    back: string;
    title: string;
    serverUrl: string;
    serverUrlDesc: string;
    testing: string;
    testConnection: string;
    connectionSuccess: string;
    connectionFailed: string;
    serverUrlEmpty: string;
    serverError: string;
    urlUpdated: string;
    saveFailed: string;
    saving: string;
    saveAndConnect: string;
    general: string;
    connection: string;
    language: string;
    languageDesc: string;
    theme: string;
    themeDesc: string;
    themeLight: string;
    themeDark: string;
    themeSystem: string;
    infoTitle: string;
    infoDefault: string;
    infoRemote: string;
    infoChange: string;
    security: string;
    devicesDesc: string;
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

  // Worktree / Isolated Session
  worktree: {
    newSessionTitle: string;
    sessionTitle: string;
    sessionTitlePlaceholder: string;
    workingMode: string;
    normalMode: string;
    normalModeDesc: string;
    isolatedMode: string;
    isolatedModeDesc: string;
    branchName: string;
    branchPrefix: string;
    create: string;
    creating: string;
    merge: string;
    merging: string;
    push: string;
    pushing: string;
    abandon: string;
    abandoning: string;
    mergeTitle: string;
    mergeDesc: string;
    commitMessage: string;
    commitMessagePlaceholder: string;
    deleteWorktree: string;
    deleteBranch: string;
    pushTitle: string;
    pushDesc: string;
    newBranchName: string;
    newBranchNamePlaceholder: string;
    abandonTitle: string;
    abandonDesc: string;
    abandonWarning: string;
    uncommittedWarning: string;
    aheadBehind: string;
    ahead: string;
    behind: string;
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

  // Login page
  login: {
    title: "OpenCode Remote",
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
    disclaimer: "AI-generated content may be inaccurate. Please verify important information.",
  },

  // Settings page
  settings: {
    back: "Back",
    title: "Connection Settings",
    serverUrl: "OpenCode Server URL",
    serverUrlDesc: "Enter the OpenCode server address you want to connect to (e.g., http://localhost:4096)",
    testing: "Testing...",
    testConnection: "Test Connection",
    connectionSuccess: "Connection test successful!",
    connectionFailed: "Failed to connect to server:",
    serverUrlEmpty: "Server URL cannot be empty",
    serverError: "Server returned error:",
    urlUpdated: "Server URL updated",
    saveFailed: "Save failed. Please check the URL format",
    saving: "Saving...",
    saveAndConnect: "Save",
    general: "General",
    connection: "Connection",
    language: "Language",
    languageDesc: "Choose your preferred interface language",
    theme: "Theme",
    themeDesc: "Choose your preferred color theme",
    themeLight: "Light",
    themeDark: "Dark",
    themeSystem: "System",
    infoTitle: "Info",
    infoDefault: "Default address is usually /opencode-api (pointing to local proxy)",
    infoRemote: "If connecting to a remote server, make sure the network is reachable",
    infoChange: "After changing the address, chat history and session list will load from the new server",
    security: "Security",
    devicesDesc: "Manage devices that can access this server",
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
    enterChatDesc: "Start using OpenCode AI assistant",
    localModeTitle: "Local Access Mode",
    localModeDesc: "You're accessing from localhost. Configure remote access below or enter chat directly.",
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

  // Worktree / Isolated Session
  worktree: {
    newSessionTitle: "New Session",
    sessionTitle: "Session Title",
    sessionTitlePlaceholder: "Enter a title for this session",
    workingMode: "Working Mode",
    normalMode: "Normal",
    normalModeDesc: "Work directly in the main repository",
    isolatedMode: "Isolated",
    isolatedModeDesc: "Create a separate worktree with its own branch",
    branchName: "Branch Name",
    branchPrefix: "opencode-remote/",
    create: "Create Session",
    creating: "Creating...",
    merge: "Merge",
    merging: "Merging...",
    push: "Push",
    pushing: "Pushing...",
    abandon: "Abandon",
    abandoning: "Abandoning...",
    mergeTitle: "Merge Changes",
    mergeDesc: "Squash merge all changes from this isolated session into the base branch",
    commitMessage: "Commit Message",
    commitMessagePlaceholder: "Describe the changes being merged",
    deleteWorktree: "Delete worktree after merge",
    deleteBranch: "Delete branch after merge",
    pushTitle: "Push to Remote",
    pushDesc: "Push changes to remote repository. You can rename the branch before pushing.",
    newBranchName: "Remote Branch Name",
    newBranchNamePlaceholder: "e.g., feature/my-feature",
    abandonTitle: "Abandon Changes",
    abandonDesc: "Discard all changes and delete this isolated session",
    abandonWarning: "This action cannot be undone. All uncommitted changes will be lost.",
    uncommittedWarning: "You have uncommitted changes",
    aheadBehind: "{ahead} ahead, {behind} behind",
    ahead: "{count} commit(s) ahead",
    behind: "{count} commit(s) behind",
  },
};
