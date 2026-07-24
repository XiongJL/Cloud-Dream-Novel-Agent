import { ipcRenderer, contextBridge } from 'electron'

// --------- Expose some API to the Renderer process ---------
contextBridge.exposeInMainWorld('db', {
    getNovels: () => ipcRenderer.invoke('db:get-novels'),
    getAllTags: (novelId?: string) => ipcRenderer.invoke('db:get-all-tags', novelId),
    createNovel: (title: string) => ipcRenderer.invoke('db:create-novel', title),
    getVolumes: (novelId: string) => ipcRenderer.invoke('db:get-volumes', novelId),
    createVolume: (data: { novelId: string; title: string }) => ipcRenderer.invoke('db:create-volume', data),
    createChapter: (data: { volumeId: string; title: string; order: number }) => ipcRenderer.invoke('db:create-chapter', data),
    deleteChapter: (data: { chapterId: string }) => ipcRenderer.invoke('db:delete-chapter', data),
    getChapter: (chapterId: string) => ipcRenderer.invoke('db:get-chapter', chapterId),
    saveChapter: (data: { chapterId: string; content: string }) => ipcRenderer.invoke('db:save-chapter', data),
    renameVolume: (data: { volumeId: string; title: string }) => ipcRenderer.invoke('db:rename-volume', data),
    renameChapter: (data: { chapterId: string; title: string }) => ipcRenderer.invoke('db:rename-chapter', data),
    updateNovel: (data: { id: string; data: { title?: string; coverUrl?: string; description?: string; formatting?: string } }) => ipcRenderer.invoke('db:update-novel', data),
    deleteNovel: (novelId: string) => ipcRenderer.invoke('db:delete-novel', novelId),
    uploadNovelCover: (novelId: string) => ipcRenderer.invoke('db:upload-novel-cover', novelId),
    importNovelFile: () => ipcRenderer.invoke('db:import-novel-file'),
    getAgentConversations: (novelId: string) => ipcRenderer.invoke('db:get-agent-conversations', novelId),
    upsertAgentConversation: (conversation: any) => ipcRenderer.invoke('db:upsert-agent-conversation', conversation),
    deleteAgentConversation: (conversationId: string) => ipcRenderer.invoke('db:delete-agent-conversation', conversationId),

    // Idea
    getIdeas: (novelId: string) => ipcRenderer.invoke('db:get-ideas', novelId),
    createIdea: (data: any) => ipcRenderer.invoke('db:create-idea', data),
    updateIdea: (id: string, data: any) => ipcRenderer.invoke('db:update-idea', id, data),
    deleteIdea: (id: string) => ipcRenderer.invoke('db:delete-idea', id),

    // Search
    search: (params: { novelId: string; keyword: string; limit?: number; offset?: number }) =>
        ipcRenderer.invoke('db:search', params),
    rebuildSearchIndex: (novelId: string) => ipcRenderer.invoke('db:rebuild-search-index', novelId),
    checkIndexStatus: (novelId: string) => ipcRenderer.invoke('db:check-index-status', novelId),

    // Story Structure
    getPlotLines: (novelId: string) => ipcRenderer.invoke('db:get-plot-lines', novelId),
    createPlotLine: (data: { novelId: string; name: string; color: string }) => ipcRenderer.invoke('db:create-plot-line', data),
    updatePlotLine: (id: string, data: any) => ipcRenderer.invoke('db:update-plot-line', { id, data }),
    deletePlotLine: (id: string) => ipcRenderer.invoke('db:delete-plot-line', id),

    createPlotPoint: (data: any) => ipcRenderer.invoke('db:create-plot-point', data),
    updatePlotPoint: (id: string, data: any) => ipcRenderer.invoke('db:update-plot-point', { id, data }),
    deletePlotPoint: (id: string) => ipcRenderer.invoke('db:delete-plot-point', id),

    createPlotPointAnchor: (data: any) => ipcRenderer.invoke('db:create-plot-point-anchor', data),
    deletePlotPointAnchor: (id: string) => ipcRenderer.invoke('db:delete-plot-point-anchor', id),

    reorderPlotLines: (novelId: string, lineIds: string[]) => ipcRenderer.invoke('db:reorder-plot-lines', { novelId, lineIds }),
    reorderPlotPoints: (plotLineId: string, pointIds: string[]) => ipcRenderer.invoke('db:reorder-plot-points', { plotLineId, pointIds }),

    // Character & Item
    getCharacters: (novelId: string) => ipcRenderer.invoke('db:get-characters', novelId),
    getCharacter: (id: string) => ipcRenderer.invoke('db:get-character', id),
    createCharacter: (data: any) => ipcRenderer.invoke('db:create-character', data),
    updateCharacter: (id: string, data: any) => ipcRenderer.invoke('db:update-character', { id, data }),
    deleteCharacter: (id: string) => ipcRenderer.invoke('db:delete-character', id),
    uploadCharacterImage: (characterId: string, type: 'avatar' | 'fullBody') => ipcRenderer.invoke('db:upload-character-image', { characterId, type }),
    deleteCharacterImage: (characterId: string, imagePath: string, type: 'avatar' | 'fullBody') => ipcRenderer.invoke('db:delete-character-image', { characterId, imagePath, type }),
    getCharacterMapLocations: (characterId: string) => ipcRenderer.invoke('db:get-character-map-locations', characterId),

    getItems: (novelId: string) => ipcRenderer.invoke('db:get-items', novelId),
    getItem: (id: string) => ipcRenderer.invoke('db:get-item', id),
    createItem: (data: any) => ipcRenderer.invoke('db:create-item', data),
    updateItem: (id: string, data: any) => ipcRenderer.invoke('db:update-item', { id, data }),
    deleteItem: (id: string) => ipcRenderer.invoke('db:delete-item', id),

    getMentionables: (novelId: string) => ipcRenderer.invoke('db:get-mentionables', novelId),

    // World Settings
    getWorldSettings: (novelId: string) => ipcRenderer.invoke('db:get-world-settings', novelId),
    createWorldSetting: (data: { novelId: string; name: string; type?: string }) => ipcRenderer.invoke('db:create-world-setting', data),
    updateWorldSetting: (id: string, data: any) => ipcRenderer.invoke('db:update-world-setting', id, data),
    deleteWorldSetting: (id: string) => ipcRenderer.invoke('db:delete-world-setting', id),

    // Relationships
    getRelationships: (characterId: string) => ipcRenderer.invoke('db:get-relationships', characterId),
    createRelationship: (data: { sourceId: string; targetId: string; relation: string; description?: string }) => ipcRenderer.invoke('db:create-relationship', data),
    deleteRelationship: (id: string) => ipcRenderer.invoke('db:delete-relationship', id),

    // Item Ownership
    getCharacterItems: (characterId: string) => ipcRenderer.invoke('db:get-character-items', characterId),
    addItemToCharacter: (data: { characterId: string; itemId: string; note?: string }) => ipcRenderer.invoke('db:add-item-to-character', data),
    removeItemFromCharacter: (id: string) => ipcRenderer.invoke('db:remove-item-from-character', id),
    updateItemOwnership: (id: string, data: { note?: string }) => ipcRenderer.invoke('db:update-item-ownership', id, data),

    // Data Aggregation
    getCharacterTimeline: (characterId: string) => ipcRenderer.invoke('db:get-character-timeline', characterId),
    getRecentChapters: (characterName: string, novelId: string, limit?: number) => ipcRenderer.invoke('db:get-recent-chapters', characterName, novelId, limit),
    getCharacterChapterAppearances: (characterId: string) => ipcRenderer.invoke('db:get-character-chapter-appearances', characterId),

    // Map System
    getMaps: (novelId: string) => ipcRenderer.invoke('db:get-maps', novelId),
    getMap: (id: string) => ipcRenderer.invoke('db:get-map', id),
    createMap: (data: { novelId: string; name: string; type?: string }) => ipcRenderer.invoke('db:create-map', data),
    updateMap: (id: string, data: any) => ipcRenderer.invoke('db:update-map', { id, data }),
    deleteMap: (id: string) => ipcRenderer.invoke('db:delete-map', id),
    uploadMapBackground: (mapId: string) => ipcRenderer.invoke('db:upload-map-bg', mapId),

    getMapMarkers: (mapId: string) => ipcRenderer.invoke('db:get-map-markers', mapId),
    createMapMarker: (data: { characterId: string; mapId: string; x: number; y: number; label?: string }) => ipcRenderer.invoke('db:create-map-marker', data),
    updateMapMarker: (id: string, data: { x?: number; y?: number; label?: string }) => ipcRenderer.invoke('db:update-map-marker', { id, data }),
    deleteMapMarker: (id: string) => ipcRenderer.invoke('db:delete-map-marker', id),

    getMapElements: (mapId: string) => ipcRenderer.invoke('db:get-map-elements', mapId),
    createMapElement: (data: { mapId: string; type: string; x: number; y: number; text?: string; iconKey?: string }) => ipcRenderer.invoke('db:create-map-element', data),
    updateMapElement: (id: string, data: any) => ipcRenderer.invoke('db:update-map-element', { id, data }),
    deleteMapElement: (id: string) => ipcRenderer.invoke('db:delete-map-element', id),
})

contextBridge.exposeInMainWorld('electron', {
    toggleFullScreen: () => ipcRenderer.invoke('app:toggle-fullscreen'),
    getUserDataPath: () => ipcRenderer.invoke('app:get-user-data-path'),
    onFullScreenChange: (callback: (isFullScreen: boolean) => void) => {
        const listener = (_event: any, state: boolean) => callback(state);
        ipcRenderer.on('app:fullscreen-change', listener);
        return () => ipcRenderer.removeListener('app:fullscreen-change', listener);
    }
})

contextBridge.exposeInMainWorld('sync', {
    pull: () => ipcRenderer.invoke('sync:pull'),
    push: () => ipcRenderer.invoke('sync:push'),
})

contextBridge.exposeInMainWorld('backup', {
    export: (password?: string) => ipcRenderer.invoke('backup:export', password),
    import: (filePath?: string, password?: string) => ipcRenderer.invoke('backup:import', { filePath, password }),
    getAutoBackups: () => ipcRenderer.invoke('backup:get-auto'),
    restoreAutoBackup: (filename: string) => ipcRenderer.invoke('backup:restore-auto', filename),
})

contextBridge.exposeInMainWorld('ai', {
    getSettings: () => ipcRenderer.invoke('ai:get-settings'),
    getMcpCliSetup: () => ipcRenderer.invoke('ai:get-mcp-cli-setup'),
    getMapImageStats: () => ipcRenderer.invoke('ai:get-map-image-stats'),
    updateSettings: (partial: any) => ipcRenderer.invoke('ai:update-settings', partial),
    testConnection: () => ipcRenderer.invoke('ai:test-connection'),
    testMcp: () => ipcRenderer.invoke('ai:test-mcp'),
    testProxy: () => ipcRenderer.invoke('ai:test-proxy'),
    testGenerate: (prompt?: string) => ipcRenderer.invoke('ai:test-generate', { prompt }),
    generateTitle: (payload: any) => ipcRenderer.invoke('ai:generate-title', payload),
    continueWriting: (payload: any) => ipcRenderer.invoke('ai:continue-writing', payload),
    previewContinuePrompt: (payload: any) => ipcRenderer.invoke('ai:preview-continue-prompt', payload),
    checkConsistency: (payload: any) => ipcRenderer.invoke('ai:check-consistency', payload),
    askNovel: (payload: any) => ipcRenderer.invoke('ai:ask-novel', payload),
    previewNovelAskPrompt: (payload: any) => ipcRenderer.invoke('ai:preview-novel-ask-prompt', payload),
    generateCreativeAssets: (payload: any) => ipcRenderer.invoke('ai:generate-creative-assets', payload),
    previewCreativeAssetsPrompt: (payload: any) => ipcRenderer.invoke('ai:preview-creative-assets-prompt', payload),
    validateCreativeAssetsDraft: (payload: any) => ipcRenderer.invoke('ai:validate-creative-assets', payload),
    confirmCreativeAssets: (payload: any) => ipcRenderer.invoke('ai:confirm-creative-assets', payload),
    generateMapImage: (payload: any) => ipcRenderer.invoke('ai:generate-map-image', payload),
    previewMapPrompt: (payload: any) => ipcRenderer.invoke('ai:preview-map-prompt', payload),
    rebuildChapterSummary: (chapterId: string) => ipcRenderer.invoke('ai:rebuild-chapter-summary', { chapterId }),
    executeAction: (actionId: string, payload?: unknown) => ipcRenderer.invoke('ai:execute-action', { actionId, payload }),
    openClawInvoke: (name: string, args?: unknown) => ipcRenderer.invoke('ai:openclaw-invoke', { name, arguments: args }),
    openClawMcpInvoke: (name: string, args?: unknown) => ipcRenderer.invoke('ai:openclaw-mcp-invoke', { name, arguments: args }),
    openClawSkillInvoke: (name: string, input?: unknown) => ipcRenderer.invoke('ai:openclaw-skill-invoke', { name, input }),
})

contextBridge.exposeInMainWorld('automation', {
    invoke: (method: string, params?: unknown, origin?: 'desktop-ui' | 'unknown') =>
        ipcRenderer.invoke('automation:invoke', { method, params, origin }),
    onDataChanged: (callback: (payload: { method: string }) => void) => {
        const listener = (_event: unknown, payload: { method: string }) => callback(payload);
        ipcRenderer.on('automation:data-changed', listener);
        return () => ipcRenderer.removeListener('automation:data-changed', listener);
    },
})

contextBridge.exposeInMainWorld('agent', {
    health: () => ipcRenderer.invoke('agent:health'),
    ensureReady: () => ipcRenderer.invoke('agent:ensure-ready'),
    restart: () => ipcRenderer.invoke('agent:restart'),
    roles: (payload?: any) => ipcRenderer.invoke('agent:invoke', { method: 'agent.roles', params: payload ?? {}, context: payload?.context }),
    chat: (payload: any, options?: { requestId?: string }) => ipcRenderer.invoke('agent:invoke', { method: 'agent.chat', params: payload, context: payload?.context, requestId: options?.requestId }),
    cancelChat: (payload: { requestId: string }) => ipcRenderer.invoke('agent:cancel-chat', payload),
    onChatProgress: (callback: (payload: any) => void) => {
        const listener = (_event: unknown, payload: any) => callback(payload);
        ipcRenderer.on('agent:chat-progress', listener);
        return () => ipcRenderer.removeListener('agent:chat-progress', listener);
    },
    plan: (payload: any) => ipcRenderer.invoke('agent:invoke', { method: 'agent.plan', params: payload, context: payload?.context }),
    registerPlan: (payload: any) => ipcRenderer.invoke('agent:invoke', { method: 'agent.register_plan', params: payload, context: payload?.context }),
    revisePlan: (payload: any) => ipcRenderer.invoke('agent:invoke', { method: 'agent.revise_plan', params: payload, context: payload?.context }),
    executePlan: (payload: any) => ipcRenderer.invoke('agent:invoke', { method: 'agent.execute_plan', params: payload, context: payload?.context }),
    retryRun: (payload: any) => ipcRenderer.invoke('agent:invoke', { method: 'agent.retry_run', params: payload, context: payload?.context }),
    reviseDraft: (payload: any) => ipcRenderer.invoke('agent:invoke', { method: 'agent.revise_draft', params: payload, context: payload?.context }),
    regenerateBatch: (payload: any) => ipcRenderer.invoke('agent:invoke', { method: 'agent.regenerate_batch', params: payload, context: payload?.context }),
    inspectSideEffect: (payload: any) => ipcRenderer.invoke('agent:invoke', { method: 'agent.inspect_side_effect', params: payload, context: payload?.context }),
    reconcileSideEffect: (payload: any) => ipcRenderer.invoke('agent:invoke', { method: 'agent.reconcile_side_effect', params: payload, context: payload?.context }),
    runStatus: (payload: any) => ipcRenderer.invoke('agent:invoke', { method: 'agent.run_status', params: payload, context: payload?.context }),
    cancel: (payload: any) => ipcRenderer.invoke('agent:invoke', { method: 'agent.cancel', params: payload, context: payload?.context }),
    submitApproval: (payload: any) => ipcRenderer.invoke('agent:invoke', { method: 'agent.submit_approval', params: payload, context: payload?.context }),
    subscribeRun: (runId: string, options?: { afterSequence?: number }) =>
        ipcRenderer.invoke('agent:subscribe-run', { runId, afterSequence: options?.afterSequence }),
    unsubscribeRun: (runId: string) => ipcRenderer.invoke('agent:unsubscribe-run', { runId }),
    onRunEvent: (callback: (event: any) => void) => {
        const listener = (_event: unknown, payload: any) => callback(payload);
        ipcRenderer.on('agent:run-event', listener);
        return () => ipcRenderer.removeListener('agent:run-event', listener);
    },
    onRunDisconnected: (callback: (payload: { runId: string; message: string }) => void) => {
        const listener = (_event: unknown, payload: { runId: string; message: string }) => callback(payload);
        ipcRenderer.on('agent:run-disconnected', listener);
        return () => ipcRenderer.removeListener('agent:run-disconnected', listener);
    },
})

contextBridge.exposeInMainWorld('agentAttachments', {
    select: (payload: { novelId: string; conversationId: string }) =>
        ipcRenderer.invoke('agent-attachment:select', payload),
    list: (payload: { novelId: string; conversationId: string }) =>
        ipcRenderer.invoke('agent-attachment:list', payload),
    get: (payload: { novelId: string; conversationId: string; attachmentId: string }) =>
        ipcRenderer.invoke('agent-attachment:get', payload),
    bind: (payload: { novelId: string; conversationId: string; messageId: string; attachmentIds: string[] }) =>
        ipcRenderer.invoke('agent-attachment:bind', payload),
    removePending: (payload: { novelId: string; conversationId: string; attachmentId: string }) =>
        ipcRenderer.invoke('agent-attachment:remove-pending', payload),
})
