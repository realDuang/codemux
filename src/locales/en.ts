// Define the structure of our translations
export interface LocaleDict {
  localServer: {
    title: string;
    description: string;
    stopped: string;
    starting: string;
    ready: string;
    stopping: string;
    error: string;
    process: string;
    external: string;
    start: string;
    stop: string;
    restart: string;
    openLogs: string;
    openManager: string;
    returnToApp: string;
    editingHint: string;
  };
  pwa: {
    install: string;
    installDescription: string;
    installTitle: string;
    installIos: string;
    installIosBrowser: string;
    done: string;
    dismiss: string;
    offline: string;
    updateAvailable: string;
    update: string;
    updateImages: string;
    updateUnsaved: string;
    updateBusy: string;
    updateFailed: string;
  };
  // Common
  markdown: {
    previewImage: string;
    closeImage: string;
    codeRegion: string;
    plainText: string;
    copyCode: string;
    wrapCode: string;
    unwrapCode: string;
    expandTable: string;
    closeTable: string;
    tableDialog: string;
    scrollHorizontally: string;
    copyTable: string;
    copyFailed: string;
    tableRegion: string;
    imageUnavailable: string;
    mediaUnavailable: string;
  };
  common: {
    loading: string;
    cancel: string;
    save: string;
    delete: string;
    confirm: string;
    back: string;
    copied: string;
    copyToClipboard: string;
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
    kindRead: string;
    kindEdit: string;
    kindOther: string;
    kindShell: string;
    kindUrlAccess: string;
    kindWebSearch: string;
    diffPreview: string;
  };
  // Question
  question: {
    submit: string;
    dismiss: string;
    stopTask: string;
    customPlaceholder: string;
    waitingAnswer: string;
    selectMultiple: string;
    back: string;
    next: string;
    progress: string;
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
    filePreview: string;
    conversationRegion: string;
    jumpToLatest: string;
    newSession: string;
    remoteAccess: string;
    settings: string;
    logout: string;
    startConversation: string;
    startConversationDesc: string;
    noSessionSelected: string;
    noSessionSelectedDesc: string;
    archivedReadOnly: string;
    initFailed: string;
    retry: string;
    disclaimer: string;
    noModeError: string;
    noModelError: string;
    queued: string;
    disconnected: string;
    dashboardTab: string;
    chatTab: string;
    teamTask: string;
    teamTaskDesc: string;
    teamTaskDetail: string;
    /** Placeholder for the custom model ID input */
    modelIdPlaceholder: string;
    /** Default mode label fallback when an engine has no available modes */
    defaultModeLabel: string;
    /** Tooltip hint shown on the chat toolbar's model/mode controls */
    sessionScopeHint: string;
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
    features: string;
    experimental: string;
    scheduledTasksEnabled: string;
    scheduledTasksEnabledDesc: string;
    teamOrchestration: string;
    teamOrchestrationDesc: string;
    teamOrchestrationRoles: string;
    teamOrchestrationRolesDesc: string;
    roleExplorer: string;
    roleResearcher: string;
    roleReviewer: string;
    roleDesigner: string;
    roleCoder: string;
  };

  // Remote Access page
  remote: {
    title: string;
    publicAccess: string;
    publicAccessDesc: string;
    starting: string;
    startFailed: string;
    namedTunnelMissingCredentials: string;
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
    accessOffDescription: string;
    accessOnDescription: string;
    accessMethod: string;
    accessCustomMethod: string;
    accessCloudflare: string;
    accessCloudflareMethod: string;
    accessExclusive: string;
    accessSwitching: string;
    accessUpdateFailed: string;
    accessUrlRequired: string;
    customAccessTitle: string;
    customAccessDesc: string;
    customAccessUrl: string;
    customAccessUrlPlaceholder: string;
    customAccessInvalid: string;
    customAccessSaved: string;
    customAccessSaveFailed: string;
    customAccessClear: string;
    customAccessConfigured: string;
    custom: string;
    customQrScan: string;
    customQrDesc: string;
    copyAddress: string;
    copyAccessCode: string;
    accessQrAlt: string;
    accessQrError: string;
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
    archiveSession: string;
    restoreSession: string;
    archivedSessions: string;
    noArchivedSessions: string;
    removeLocalSession: string;
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
    noProjects: string;
    defaultWorkspace: string;
    projectsTitle: string;
    activeSection: string;
    pinSession: string;
    unpinSession: string;
  };

  catalog: {
    sessions: string;
    unavailable: string;
    unavailableDetail: string;
    updateFailed: string;
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
    addNotAvailable: string;
    hideTitle: string;
    hideConfirm: string;
    sessionCount: string;
    hideWarning: string;
    hideNote: string;
  };

  // Prompt Input
  prompt: {
    draftImagesNotSaved: string;
    draftSaveFailed: string;
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
    imageTotalTooLarge: string;
    removeImage: string;
    /** Slash command autocomplete: no matching commands */
    noCommandsFound: string;
    reasoningEffortLow: string;
    reasoningEffortMedium: string;
    reasoningEffortHigh: string;
    reasoningEffortMax: string;
    reasoningEffortUltra: string;
  };

  activity: {
    searchedIn: string;
    searchingIn: string;
    loadedTools: string;
    loadingTools: string;
    readFiles: string;
    readingFiles: string;
    ranCommands: string;
    runningCommands: string;
    changedFiles: string;
    changingFiles: string;
    searchedWeb: string;
    searchingWeb: string;
    calledTools: string;
    callingTools: string;
    readSkill: string;
    readingSkill: string;
    readFile: string;
    readingFile: string;
    searched: string;
    searching: string;
    listed: string;
    listing: string;
    ranCommand: string;
    runningCommand: string;
    separator: string;
  };

  // Message Parts
  parts: {
    linkToMessage: string;
    toolInput: string;
    toolOutput: string;
    toolPending: string;
    toolCompleted: string;
    readFile: string;
    thinking: string;
    memorySources: string;
    thought: string;
    thoughtFor: string;
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
    toolUses: string;
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
    stoppedByUser: string;
    interrupted: string;
    emptyResponse: string;
    contextCompressed: string;
    elicitationAccepted: string;
    elicitationDeclined: string;
    elicitationCancelled: string;
    elicitationCompleted: string;
    planImplementationPending: string;
    planImplementationCompleted: string;
    streamReconnecting: string;
    turnFinished: string;
    sessionResumed: string;
    automaticApprovalReview: string;
    automaticApprovalApproved: string;
    automaticApprovalDenied: string;
    automaticApprovalAborted: string;
    automaticApprovalTimedOut: string;
    strictReviewRequired: string;
    autoReviewInterrupted: string;
    apiRetry: string;
    permissionDenied: string;
    rateLimitWarning: string;
    rateLimitRejected: string;
    rateLimitRejectedNoReset: string;
    compactFailed: string;
    authError: string;
    conversationReset: string;
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
    inactiveCleanupTip: string;
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
    reasoningEffort: string;
    reasoningEffortDesc: string;
    fastMode: string;
    fastModeDesc: string;
    fastModeUnavailable: string;
    /** Hint explaining that engine-level model/effort/fastMode are defaults for new sessions */
    sessionDefaultsHint: string;
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
    platform: string;
    platformDesc: string;
    platformFeishu: string;
    platformLark: string;
    dingtalkBot: string;
    dingtalkBotDesc: string;
    telegramBot: string;
    telegramBotDesc: string;
    wecomBot: string;
    wecomBotDesc: string;
    teamsBot: string;
    teamsBotDesc: string;
    weixinIlinkBot: string;
    weixinIlinkBotDesc: string;
    weixinIlinkLoginTitle: string;
    weixinIlinkLoading: string;
    weixinIlinkScanPrompt: string;
    weixinIlinkScanedPrompt: string;
    weixinIlinkConfirmedPrompt: string;
    weixinIlinkExpired: string;
    weixinIlinkRefresh: string;
    weixinIlinkError: string;
    weixinIlinkRetry: string;
    weixinIlinkAlreadyConfigured: string;
    weixinIlinkLogout: string;
    weixinIlinkLogoutConfirm: string;
    weixinIlinkLoginRequiredHint: string;
    weixinIlinkSessionExpired: string;
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
    login: string;
    configRequired: string;
    secretConfiguredHint: string;
    save: string;
    saving: string;
    saveFailed: string;
    directConnect: string;
    directConnectBadge: string;
    webhookConnect: string;
    webhookConnectBadge: string;
    tunnelRequired: string;
    tunnelRequiredDesc: string;
    accessUrlRequired: string;
    accessUrlRequiredDesc: string;
    webhookReachabilityHint: string;
    teamsWebhookGuide: string;
    wecomWebhookGuide: string;
    webhookEndpoint: string;
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
    messageSendInterrupted: string;
    sessionCreateFailed: string;
    sessionDeleteFailed: string;
    sessionArchiveFailed: string;
    gatewayDisconnected: string;
    gatewayReconnected: string;
    engineError: string;
    defaultEngineSaveFailed: string;
  };

  // File Explorer
  fileExplorer: {
    title: string;
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

  // Integrated Terminal
  terminal: {
    togglePanel: string;
    newTab: string;
    closeTab: string;
    closePanel: string;
    tabLabel: string;
    exitedBadge: string;
    notConnected: string;
    // Search overlay
    searchTitle: string;
    searchPlaceholder: string;
    searchPrev: string;
    searchNext: string;
    searchClose: string;
    searchCaseSensitive: string;
    searchWholeWord: string;
    searchRegex: string;
    searchMatchCount: string;
    searchNoMatch: string;
    // Profile menu
    profileMenuTitle: string;
    profileNewWith: string;
    profileSelectDefault: string;
    profileNoneFound: string;
    profileDefaultBadge: string;
    // Status / errors
    waitingForGateway: string;
    startFailed: string;
    // Settings page
    settingsSectionTitle: string;
    settingsSectionDesc: string;
    settingsDefaultProfile: string;
    settingsDefaultProfileDesc: string;
    settingsGpuMode: string;
    settingsGpuModeDesc: string;
    settingsGpuAuto: string;
    settingsGpuCanvas: string;
    settingsGpuDom: string;
    // File link
    openFileLink: string;
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
    directoryPlaceholder: string;
    lessThanOneMinute: string;
    fieldRequired: string;
    daysRequired: string;
  };
  worktree: {
    title: string;
    local: string;
    sandbox: string;
    create: string;
    remove: string;
    merge: string;
    noSessions: string;
    confirmDelete: string;
    mergeSuccess: string;
    mergeConflict: string;
    mergeFailed: string;
    baseBranch: string;
    targetBranch: string;
    name: string;
    branch: string;
    enabled: string;
    enabledDesc: string;
    creating: string;
    merging: string;
    namePlaceholder: string;
    mergeMode: string;
    modeMergeDesc: string;
    modeSquashDesc: string;
    modeRebaseDesc: string;
    mergeMessage: string;
    deleteConfirmTitle: string;
    deleteWarningTitle: string;
    deleteImpactFiles: string;
    deleteImpactBranch: string;
    deleteImpactSessions: string;
    deleteIrreversible: string;
  };
}

export const en: LocaleDict = {
  localServer: {
    title: "Local server",
    description: "Manage the CodeMux server on this computer.",
    stopped: "Stopped",
    starting: "Starting services…",
    ready: "Running",
    stopping: "Stopping services…",
    error: "Server unavailable",
    process: "PID {pid}",
    external: "This server was started outside CodeMux Desktop and keeps running when you close the desktop app. Use its original launcher to restart it and preserve its launch settings.",
    start: "Start server",
    stop: "Stop server",
    restart: "Restart server",
    openLogs: "Open logs",
    openManager: "Manage server",
    returnToApp: "Return to CodeMux",
    editingHint: "Your open conversation and drafts remain available. Sending messages and server actions require the server to be running.",
  },
  pwa: {
    install: "Install",
    installDescription: "Open CodeMux from your home screen.",
    installTitle: "Add CodeMux to your home screen",
    installIos: "Open the Share menu, choose “Add to Home Screen”, then tap “Add”.",
    installIosBrowser: "If the option is missing, open this address in Safari.",
    done: "Got it",
    dismiss: "Dismiss",
    offline: "You are offline. Reconnect to send messages and receive updates.",
    updateAvailable: "A new version of CodeMux is ready.",
    update: "Refresh",
    updateImages: "Send or remove draft images before refreshing.",
    updateUnsaved: "A draft could not be saved. Copy your text before refreshing manually.",
    updateBusy: "A response is in progress. Refresh when it finishes.",
    updateFailed: "The update failed. Please try again.",
  },
  // Common
  markdown: {
    previewImage: "View image",
    closeImage: "Close image",
    codeRegion: "Code block",
    plainText: "Plain text",
    copyCode: "Copy code",
    wrapCode: "Wrap lines",
    unwrapCode: "Disable line wrapping",
    expandTable: "Expand table",
    closeTable: "Close table",
    tableDialog: "Table details",
    scrollHorizontally: "Scroll horizontally to view more",
    copyTable: "Copy table",
    copyFailed: "Copy failed",
    tableRegion: "Table",
    imageUnavailable: "Image unavailable",
    mediaUnavailable: "Media unavailable",
  },
  common: {
    loading: "Loading...",
    cancel: "Cancel",
    save: "Save",
    delete: "Delete",
    confirm: "Confirm",
    back: "Back",
    copied: "Copied!",
    copyToClipboard: "Copy to clipboard",
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
    kindRead: "File Read",
    kindEdit: "File Edit",
    kindOther: "Permission Request",
    kindShell: "Shell Command",
    kindUrlAccess: "URL Access",
    kindWebSearch: "Web Search",
    diffPreview: "Changes",
  },
  // Question
  question: {
    submit: "Submit",
    dismiss: "Dismiss",
    stopTask: "Stop task",
    customPlaceholder: "Type a custom answer...",
    waitingAnswer: "Waiting for answer",
    selectMultiple: "Select multiple options",
    back: "Back",
    next: "Next",
    progress: "Question {current} of {total}",
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
    filePreview: "File preview",
    conversationRegion: "Conversation",
    jumpToLatest: "Jump to latest",
    newSession: "New Session",
    remoteAccess: "Remote Access",
    settings: "Settings",
    logout: "Logout",
    startConversation: "Start a new conversation",
    startConversationDesc: "Select a model and type any question in the input box below to start chatting.",
    noSessionSelected: "No session selected",
    noSessionSelectedDesc: "Select a session from the sidebar or create a new one to get started.",
    archivedReadOnly: "This conversation is archived. Restore it to continue.",
    initFailed: "Initialization Failed",
    retry: "Retry",
    disclaimer: "AI-generated content may be inaccurate. Please verify important information.",
    noModeError: "No mode selected. Please select a mode before sending.",
    noModelError: "No model configured. Please set a model in Settings > Engines.",
    queued: "Queued",
    disconnected: "Disconnected",
    dashboardTab: "Dashboard",
    chatTab: "Chat",
    teamTask: "Team Task",
    teamTaskDesc: "Describe the task you want multiple engines to collaborate on.",
    teamTaskDetail: "The task will be decomposed into subtasks and dispatched to different engines in parallel.",
    modelIdPlaceholder: "Enter model ID...",
    defaultModeLabel: "Build",
    sessionScopeHint: "Applies to this session only. Defaults for new sessions live in Settings.",
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
    features: "Features",
    experimental: "Experimental",
    scheduledTasksEnabled: "Scheduled Tasks",
    scheduledTasksEnabledDesc: "Enable the scheduled tasks feature to automatically run tasks on a schedule",
    teamOrchestration: "Cross-Engine Team Orchestration",
    teamOrchestrationDesc: "Decompose complex tasks and distribute subtasks across multiple AI engines for parallel execution",
    teamOrchestrationRoles: "Role-Engine Mapping",
    teamOrchestrationRolesDesc: "Configure which engine handles each agent role during team orchestration",
    roleExplorer: "Explorer",
    roleResearcher: "Researcher",
    roleReviewer: "Reviewer",
    roleDesigner: "Designer",
    roleCoder: "Coder",
  },

  // Remote Access page
  remote: {
    title: "Remote Access",
    publicAccess: "Cloudflare Tunnel",
    publicAccessDesc: "Access via Cloudflare tunnel from the internet",
    starting: "Starting tunnel, please wait...",
    startFailed: "Failed to start. Please ensure cloudflared is installed",
    namedTunnelMissingCredentials: "Named Tunnel credentials were not found. CodeMux needs a ~/.cloudflared/<tunnel-id>.json credential file to start this fixed domain. Run the Cloudflare setup commands below, or clear the custom domain to use a temporary quick tunnel.",
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
    publicAccessTab: "Remote Access",
    publicAccessTabDesc: "Use your own IP or domain, or enable Cloudflare Tunnel, for browser access and webhook callbacks.",
    accessOffDescription: "Remote access is off. This computer can still use CodeMux locally.",
    accessOnDescription: "Remote access is enabled with the selected method.",
    accessMethod: "Access method",
    accessCustomMethod: "Use your own IP, domain, or network forwarding.",
    accessCloudflare: "Cloudflare Tunnel",
    accessCloudflareMethod: "CodeMux starts and manages a Cloudflare connector.",
    accessExclusive: "Only one method can be active. Switching disconnects existing remote clients.",
    accessSwitching: "Updating remote access…",
    accessUpdateFailed: "Could not update remote access. Check the host connection and configuration, then try again.",
    accessUrlRequired: "Save a custom address below before enabling this method.",
    customAccessTitle: "Custom Access",
    customAccessDesc: "Use an address that already routes to this CodeMux host. Configure network access and HTTPS externally; saving an address does not create a tunnel.",
    customAccessUrl: "Custom Access URL",
    customAccessUrlPlaceholder: "http://192.168.1.20:8233 or https://codemux.example.com",
    customAccessInvalid: "Enter an HTTP or HTTPS address with an optional port. Paths, query parameters, fragments, and credentials are not supported.",
    customAccessSaved: "Access address saved.",
    customAccessSaveFailed: "Could not save the access address. Try again.",
    customAccessClear: "Clear",
    customAccessConfigured: "Custom access address configured",
    custom: "Custom",
    customQrScan: "Scan to open your custom address",
    customQrDesc: "Your device must be able to reach the configured IP or domain.",
    copyAddress: "Copy address",
    copyAccessCode: "Copy access code",
    accessQrAlt: "CodeMux access QR code",
    accessQrError: "Could not generate the QR code.",
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
    noteKeepRunningDesc: "CodeMux must remain running on this computer. Closing the app or putting the computer to sleep interrupts remote access.",
    notes: "Notes",
    publicAccessEnabled: "Public Access enabled — Cloudflare Tunnel running",
    publicAccessDisabled: "Set up a custom address or Cloudflare Tunnel",
    goToPublicAccess: "Set Up Remote Access",
  },

  // Session Sidebar
  sidebar: {
    noSessions: "No sessions",
    loadingSessions: "Loading sessions...",
    newSession: "New session",
    deleteConfirm: "Are you sure you want to delete this session?",
    deleteSession: "Delete session",
    archiveSession: "Archive",
    restoreSession: "Restore",
    archivedSessions: "Archived",
    noArchivedSessions: "No archived conversations",
    removeLocalSession: "Remove from CodeMux (keep the original conversation)",
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
    noProjects: "No projects yet",
    defaultWorkspace: "Default Workspace",
    projectsTitle: "Projects",
    activeSection: "Active",
    pinSession: "Pin to Active",
    unpinSession: "Unpin",
  },

  catalog: {
    sessions: "Synced conversations",
    unavailable: "Unavailable",
    unavailableDetail: "This conversation is no longer available from its source. Saved history is preserved.",
    updateFailed: "Could not update the conversation: {message}",
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
    addNotAvailable: "Add Project is only available in desktop app or server mode",
    hideTitle: "Delete Project Sessions",
    hideConfirm: "Delete all sessions for project \"{name}\"?",
    sessionCount: "This will delete {count} session(s).",
    hideWarning: "Session history will be permanently deleted.",
    hideNote: "The project will reappear when new sessions are created.",
  },

  // Prompt Input
  prompt: {
    draftImagesNotSaved: "Text is saved on this device. Reattach images after reopening.",
    draftSaveFailed: "This draft could not be saved on this device. Keep this page open or copy your text.",
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
    imageTotalTooLarge: "Total image size too large (max 12MB)",
    removeImage: "Remove image",
    noCommandsFound: "No commands found",
    reasoningEffortLow: "Low",
    reasoningEffortMedium: "Medium",
    reasoningEffortHigh: "High",
    reasoningEffortMax: "Max",
    reasoningEffortUltra: "Ultra",
  },
  activity: {
    searchedIn: "Searched {path} for “{query}”",
    searchingIn: "Searching {path} for “{query}”",
    loadedTools: "Loaded tools",
    loadingTools: "Loading tools",
    readFiles: "Read files",
    readingFiles: "Reading files",
    ranCommands: "Ran commands",
    runningCommands: "Running commands",
    changedFiles: "Changed files",
    changingFiles: "Changing files",
    searchedWeb: "Searched the web",
    searchingWeb: "Searching the web",
    calledTools: "Called tools",
    callingTools: "Calling tools",
    readSkill: "Read {target} skill",
    readingSkill: "Reading {target} skill",
    readFile: "Read {target}",
    readingFile: "Reading {target}",
    searched: "Searched {target}",
    searching: "Searching {target}",
    listed: "Listed {target}",
    listing: "Listing {target}",
    ranCommand: "Ran {target}",
    runningCommand: "Running {target}",
    separator: " · ",
  },
  parts: {
    linkToMessage: "Link to this message",
    toolInput: "Input",
    toolOutput: "Output",
    toolPending: "Pending",
    toolCompleted: "Completed",
    readFile: "Read file",
    thinking: "Thinking",
    memorySources: "Memory sources",
    thought: "Thought",
    thoughtFor: "Thought for {duration}",
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
    toolUses: "{count} tool uses",
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
    stoppedByUser: "Stopped by user.",
    interrupted: "Model response interrupted unexpectedly.",
    emptyResponse: "Unexpected empty response. Try sending your message again.",
    contextCompressed: "Context has been automatically compressed",
    elicitationAccepted: "Request accepted",
    elicitationDeclined: "Request declined",
    elicitationCancelled: "Request cancelled",
    elicitationCompleted: "Request completed",
    planImplementationPending: "Plan awaiting implementation",
    planImplementationCompleted: "Plan request completed",
    streamReconnecting: "Connection interrupted. Reconnecting…",
    turnFinished: "Turn finished",
    sessionResumed: "Session has been resumed",
    automaticApprovalReview: "Automatic approval review is in progress",
    automaticApprovalApproved: "Automatic approval review approved the action",
    automaticApprovalDenied: "Automatic approval review denied the action",
    automaticApprovalAborted: "Automatic approval review was aborted",
    automaticApprovalTimedOut: "Automatic approval review timed out",
    strictReviewRequired: "Strict review is required before continuing",
    autoReviewInterrupted: "Automatic approval review was interrupted",
    apiRetry: "API request failed ({error}). Retrying {attempt}/{max} in {seconds}s…",
    permissionDenied: "{tool} was denied automatically: {reason}",
    rateLimitWarning: "Approaching your usage limit ({percent}% used)",
    rateLimitRejected: "Usage limit reached. Resets at {resetsAt}",
    rateLimitRejectedNoReset: "Usage limit reached",
    compactFailed: "Context compaction failed: {error}",
    authError: "Authentication error: {error}",
    conversationReset: "Context cleared — a new conversation started",
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
    inactiveCleanupTip: "Devices inactive for more than 14 days are automatically removed and will need to re-authorize",
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
    reasoningEffort: "Reasoning Effort",
    reasoningEffortDesc: "Controls how much effort the model puts into reasoning",
    fastMode: "Fast Mode",
    fastModeDesc: "Higher speed inference at 2\u00d7 credit usage (Codex only)",
    fastModeUnavailable: "Fast mode requires ChatGPT authentication",
    sessionDefaultsHint: "These settings apply only to newly created sessions. Existing sessions keep their own per-session model, mode, and effort overrides — adjust those from the chat toolbar.",
    noModelsAvailable: "No models available",
    modelInputPlaceholder: "Enter model ID (e.g. claude-sonnet-4-20250514)",
    enabled: "Enabled",
    disabled: "Disabled",
    unavailable: "Unavailable",
  },
  channel: {
    channels: "Channels",
    feishuBot: "Feishu / Lark Bot",
    feishuBotDesc: "Connect to Feishu or Lark to use CodeMux via bot messages",
    platform: "Platform",
    platformDesc: "Choose the developer console that matches your bot app",
    platformFeishu: "Feishu (open.feishu.cn)",
    platformLark: "Lark (open.larksuite.com)",
    dingtalkBot: "DingTalk Bot",
    dingtalkBotDesc: "Connect to DingTalk to use CodeMux via robot messages",
    telegramBot: "Telegram Bot",
    telegramBotDesc: "Connect to Telegram to use CodeMux via bot messages",
    wecomBot: "WeCom Bot",
    wecomBotDesc: "Connect to WeCom (WeChat Work) to use CodeMux via app messages",
    teamsBot: "Teams Bot",
    teamsBotDesc: "Connect to Microsoft Teams to use CodeMux via bot messages",
    weixinIlinkBot: "WeChat Personal (iLink)",
    weixinIlinkBotDesc: "Connect to WeChat personal account via iLink (QR-scan login)",
    weixinIlinkLoginTitle: "WeChat iLink Login",
    weixinIlinkLoading: "Fetching QR code...",
    weixinIlinkScanPrompt: "Open WeChat on your phone and scan the QR code.",
    weixinIlinkScanedPrompt: "Scanned. Confirm login on your phone...",
    weixinIlinkConfirmedPrompt: "Login confirmed, saving...",
    weixinIlinkExpired: "QR code expired.",
    weixinIlinkRefresh: "Refresh QR code",
    weixinIlinkError: "Failed to fetch QR code.",
    weixinIlinkRetry: "Retry",
    weixinIlinkAlreadyConfigured: "A bot is already configured. Scanning will replace it.",
    weixinIlinkLogout: "Logout",
    weixinIlinkLogoutConfirm: "Log out the current WeChat account? This stops the bot and clears all saved session bindings on this device. The remote WeChat session may stay valid until it expires server-side.",
    weixinIlinkLoginRequiredHint: "Click Login and scan the QR code first.",
    weixinIlinkSessionExpired: "WeChat session expired — please scan the QR code again to re-login.",
    appId: "App ID",
    appIdPlaceholder: "Enter Feishu / Lark App ID",
    appSecret: "App Secret",
    appSecretPlaceholder: "Enter Feishu / Lark App Secret",
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
    streamingThrottleDesc: "Minimum interval between Feishu / Lark message updates",
    ms: "ms",
    configure: "Configure",
    login: "Login",
    configRequired: "App ID and App Secret are required to enable the bot",
    secretConfiguredHint: "Configured — leave empty to keep current",
    save: "Save",
    saving: "Saving...",
    saveFailed: "Save failed",
    directConnect: "Direct",
    directConnectBadge: "Outbound",
    webhookConnect: "Requires Public Access",
    webhookConnectBadge: "Webhook",
    tunnelRequired: "Public Access not enabled",
    tunnelRequiredDesc: "Go to Public Access tab to enable Tunnel for webhook channels",
    accessUrlRequired: "No access address configured",
    accessUrlRequiredDesc: "Configure a custom address or start Cloudflare Tunnel in Remote Access.",
    webhookReachabilityHint: "The channel provider must be able to reach this address. A private or LAN address may not support webhook callbacks.",
    teamsWebhookGuide: "Configure this URL as Messaging Endpoint in Azure Bot Service → Settings",
    wecomWebhookGuide: "Configure this URL as callback URL in WeCom Admin Console → App → Receive Messages",
    webhookEndpoint: "Endpoint",
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
    messageSendInterrupted: "Sending was interrupted. Check the conversation before sending again.",
    sessionCreateFailed: "Failed to create session.",
    sessionDeleteFailed: "Failed to delete session.",
    sessionArchiveFailed: "Could not change archived state: {message}",
    gatewayDisconnected: "Connection lost. Reconnecting...",
    gatewayReconnected: "Connection restored.",
    engineError: "Engine error: {message}",
    defaultEngineSaveFailed: "Failed to save the default engine.",
  },

  // File Explorer
  fileExplorer: {
    title: "File explorer",
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

  terminal: {
    togglePanel: "Toggle terminal (Ctrl+`)",
    newTab: "New terminal (Ctrl+Shift+`)",
    closeTab: "Close terminal (Ctrl+Shift+W)",
    closePanel: "Hide terminal panel",
    tabLabel: "Terminal {n}",
    exitedBadge: "Exited",
    notConnected: "Not connected to gateway",
    searchTitle: "Find in terminal (Ctrl+F)",
    searchPlaceholder: "Find",
    searchPrev: "Previous match (Shift+Enter)",
    searchNext: "Next match (Enter)",
    searchClose: "Close (Esc)",
    searchCaseSensitive: "Match case",
    searchWholeWord: "Match whole word",
    searchRegex: "Use regular expression",
    searchMatchCount: "{current} of {total}",
    searchNoMatch: "No results",
    profileMenuTitle: "Select profile",
    profileNewWith: "New terminal with profile",
    profileSelectDefault: "Select default profile",
    profileNoneFound: "No shells detected",
    profileDefaultBadge: "default",
    waitingForGateway: "Waiting for gateway connection…",
    startFailed: "Failed to start terminal",
    settingsSectionTitle: "Terminal",
    settingsSectionDesc: "Configure shell profiles and renderer for the integrated terminal.",
    settingsDefaultProfile: "Default profile",
    settingsDefaultProfileDesc: "Used when opening new terminals without specifying a profile.",
    settingsGpuMode: "GPU acceleration",
    settingsGpuModeDesc: "Auto = WebGL with Canvas/DOM fallback. Change if you see rendering glitches.",
    settingsGpuAuto: "Auto (WebGL)",
    settingsGpuCanvas: "Canvas",
    settingsGpuDom: "DOM",
    openFileLink: "Open {path}",
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
    taskFailed: "Scheduled task failed: {error}",
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
    directoryPlaceholder: "/path/to/project",
    lessThanOneMinute: "< 1m",
    fieldRequired: "{field} is required",
    daysRequired: "Select at least one day",
  },
  worktree: {
    title: "Worktree",
    local: "Local",
    sandbox: "Sandbox",
    create: "Create Worktree",
    remove: "Remove Worktree",
    merge: "Merge Worktree",
    noSessions: "No sessions",
    confirmDelete: "Are you sure you want to remove worktree \"{name}\"? This will delete the working directory and branch.",
    mergeSuccess: "Successfully merged {branch} into {target}",
    mergeConflict: "Merge conflict in {count} file(s)",
    mergeFailed: "Merge failed: {message}",
    baseBranch: "Base Branch",
    targetBranch: "Target Branch",
    name: "Name",
    branch: "Branch",
    enabled: "Enable Worktree",
    enabledDesc: "Allow creating isolated git worktrees per project for parallel development",
    creating: "Creating worktree...",
    merging: "Merging...",
    namePlaceholder: "Optional name (auto-generated if empty)",
    mergeMode: "Merge Mode",
    modeMergeDesc: "Create a merge commit preserving full history",
    modeSquashDesc: "Combine all commits into one on the target branch",
    modeRebaseDesc: "Replay commits on top of the target branch",
    mergeMessage: "Commit Message",
    deleteConfirmTitle: "Delete worktree \"{name}\"?",
    deleteWarningTitle: "This action will:",
    deleteImpactFiles: "Delete the worktree working directory and all local files",
    deleteImpactBranch: "Delete the associated git branch",
    deleteImpactSessions: "Remove {count} session(s) linked to this worktree",
    deleteIrreversible: "This action cannot be undone. Uncommitted changes will be lost.",
  },
};
