"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("db", {
  getNovels: () => electron.ipcRenderer.invoke("db:get-novels"),
  getAllTags: (novelId) => electron.ipcRenderer.invoke("db:get-all-tags", novelId),
  createNovel: (title) => electron.ipcRenderer.invoke("db:create-novel", title),
  getVolumes: (novelId) => electron.ipcRenderer.invoke("db:get-volumes", novelId),
  createVolume: (data) => electron.ipcRenderer.invoke("db:create-volume", data),
  createChapter: (data) => electron.ipcRenderer.invoke("db:create-chapter", data),
  deleteChapter: (data) => electron.ipcRenderer.invoke("db:delete-chapter", data),
  getChapter: (chapterId) => electron.ipcRenderer.invoke("db:get-chapter", chapterId),
  saveChapter: (data) => electron.ipcRenderer.invoke("db:save-chapter", data),
  renameVolume: (data) => electron.ipcRenderer.invoke("db:rename-volume", data),
  renameChapter: (data) => electron.ipcRenderer.invoke("db:rename-chapter", data),
  updateNovel: (data) => electron.ipcRenderer.invoke("db:update-novel", data),
  deleteNovel: (novelId) => electron.ipcRenderer.invoke("db:delete-novel", novelId),
  uploadNovelCover: (novelId) => electron.ipcRenderer.invoke("db:upload-novel-cover", novelId),
  // Idea
  getIdeas: (novelId) => electron.ipcRenderer.invoke("db:get-ideas", novelId),
  createIdea: (data) => electron.ipcRenderer.invoke("db:create-idea", data),
  updateIdea: (id, data) => electron.ipcRenderer.invoke("db:update-idea", id, data),
  deleteIdea: (id) => electron.ipcRenderer.invoke("db:delete-idea", id),
  // Search
  search: (params) => electron.ipcRenderer.invoke("db:search", params),
  rebuildSearchIndex: (novelId) => electron.ipcRenderer.invoke("db:rebuild-search-index", novelId),
  checkIndexStatus: (novelId) => electron.ipcRenderer.invoke("db:check-index-status", novelId),
  // Story Structure
  getPlotLines: (novelId) => electron.ipcRenderer.invoke("db:get-plot-lines", novelId),
  createPlotLine: (data) => electron.ipcRenderer.invoke("db:create-plot-line", data),
  updatePlotLine: (id, data) => electron.ipcRenderer.invoke("db:update-plot-line", { id, data }),
  deletePlotLine: (id) => electron.ipcRenderer.invoke("db:delete-plot-line", id),
  createPlotPoint: (data) => electron.ipcRenderer.invoke("db:create-plot-point", data),
  updatePlotPoint: (id, data) => electron.ipcRenderer.invoke("db:update-plot-point", { id, data }),
  deletePlotPoint: (id) => electron.ipcRenderer.invoke("db:delete-plot-point", id),
  createPlotPointAnchor: (data) => electron.ipcRenderer.invoke("db:create-plot-point-anchor", data),
  deletePlotPointAnchor: (id) => electron.ipcRenderer.invoke("db:delete-plot-point-anchor", id),
  reorderPlotLines: (novelId, lineIds) => electron.ipcRenderer.invoke("db:reorder-plot-lines", { novelId, lineIds }),
  reorderPlotPoints: (plotLineId, pointIds) => electron.ipcRenderer.invoke("db:reorder-plot-points", { plotLineId, pointIds }),
  // Character & Item
  getCharacters: (novelId) => electron.ipcRenderer.invoke("db:get-characters", novelId),
  getCharacter: (id) => electron.ipcRenderer.invoke("db:get-character", id),
  createCharacter: (data) => electron.ipcRenderer.invoke("db:create-character", data),
  updateCharacter: (id, data) => electron.ipcRenderer.invoke("db:update-character", { id, data }),
  deleteCharacter: (id) => electron.ipcRenderer.invoke("db:delete-character", id),
  uploadCharacterImage: (characterId, type) => electron.ipcRenderer.invoke("db:upload-character-image", { characterId, type }),
  deleteCharacterImage: (characterId, imagePath, type) => electron.ipcRenderer.invoke("db:delete-character-image", { characterId, imagePath, type }),
  getCharacterMapLocations: (characterId) => electron.ipcRenderer.invoke("db:get-character-map-locations", characterId),
  getItems: (novelId) => electron.ipcRenderer.invoke("db:get-items", novelId),
  getItem: (id) => electron.ipcRenderer.invoke("db:get-item", id),
  createItem: (data) => electron.ipcRenderer.invoke("db:create-item", data),
  updateItem: (id, data) => electron.ipcRenderer.invoke("db:update-item", { id, data }),
  deleteItem: (id) => electron.ipcRenderer.invoke("db:delete-item", id),
  getMentionables: (novelId) => electron.ipcRenderer.invoke("db:get-mentionables", novelId),
  // World Settings
  getWorldSettings: (novelId) => electron.ipcRenderer.invoke("db:get-world-settings", novelId),
  createWorldSetting: (data) => electron.ipcRenderer.invoke("db:create-world-setting", data),
  updateWorldSetting: (id, data) => electron.ipcRenderer.invoke("db:update-world-setting", id, data),
  deleteWorldSetting: (id) => electron.ipcRenderer.invoke("db:delete-world-setting", id),
  // Relationships
  getRelationships: (characterId) => electron.ipcRenderer.invoke("db:get-relationships", characterId),
  createRelationship: (data) => electron.ipcRenderer.invoke("db:create-relationship", data),
  deleteRelationship: (id) => electron.ipcRenderer.invoke("db:delete-relationship", id),
  // Item Ownership
  getCharacterItems: (characterId) => electron.ipcRenderer.invoke("db:get-character-items", characterId),
  addItemToCharacter: (data) => electron.ipcRenderer.invoke("db:add-item-to-character", data),
  removeItemFromCharacter: (id) => electron.ipcRenderer.invoke("db:remove-item-from-character", id),
  updateItemOwnership: (id, data) => electron.ipcRenderer.invoke("db:update-item-ownership", id, data),
  // Data Aggregation
  getCharacterTimeline: (characterId) => electron.ipcRenderer.invoke("db:get-character-timeline", characterId),
  getRecentChapters: (characterName, novelId, limit) => electron.ipcRenderer.invoke("db:get-recent-chapters", characterName, novelId, limit),
  getCharacterChapterAppearances: (characterId) => electron.ipcRenderer.invoke("db:get-character-chapter-appearances", characterId),
  // Map System
  getMaps: (novelId) => electron.ipcRenderer.invoke("db:get-maps", novelId),
  getMap: (id) => electron.ipcRenderer.invoke("db:get-map", id),
  createMap: (data) => electron.ipcRenderer.invoke("db:create-map", data),
  updateMap: (id, data) => electron.ipcRenderer.invoke("db:update-map", { id, data }),
  deleteMap: (id) => electron.ipcRenderer.invoke("db:delete-map", id),
  uploadMapBackground: (mapId) => electron.ipcRenderer.invoke("db:upload-map-bg", mapId),
  getMapMarkers: (mapId) => electron.ipcRenderer.invoke("db:get-map-markers", mapId),
  createMapMarker: (data) => electron.ipcRenderer.invoke("db:create-map-marker", data),
  updateMapMarker: (id, data) => electron.ipcRenderer.invoke("db:update-map-marker", { id, data }),
  deleteMapMarker: (id) => electron.ipcRenderer.invoke("db:delete-map-marker", id),
  getMapElements: (mapId) => electron.ipcRenderer.invoke("db:get-map-elements", mapId),
  createMapElement: (data) => electron.ipcRenderer.invoke("db:create-map-element", data),
  updateMapElement: (id, data) => electron.ipcRenderer.invoke("db:update-map-element", { id, data }),
  deleteMapElement: (id) => electron.ipcRenderer.invoke("db:delete-map-element", id)
});
electron.contextBridge.exposeInMainWorld("electron", {
  toggleFullScreen: () => electron.ipcRenderer.invoke("app:toggle-fullscreen"),
  getUserDataPath: () => electron.ipcRenderer.invoke("app:get-user-data-path"),
  onFullScreenChange: (callback) => {
    const listener = (_event, state) => callback(state);
    electron.ipcRenderer.on("app:fullscreen-change", listener);
    return () => electron.ipcRenderer.removeListener("app:fullscreen-change", listener);
  }
});
electron.contextBridge.exposeInMainWorld("sync", {
  pull: () => electron.ipcRenderer.invoke("sync:pull"),
  push: () => electron.ipcRenderer.invoke("sync:push")
});
electron.contextBridge.exposeInMainWorld("backup", {
  export: (password) => electron.ipcRenderer.invoke("backup:export", password),
  import: (filePath, password) => electron.ipcRenderer.invoke("backup:import", { filePath, password }),
  getAutoBackups: () => electron.ipcRenderer.invoke("backup:get-auto"),
  restoreAutoBackup: (filename) => electron.ipcRenderer.invoke("backup:restore-auto", filename)
});
electron.contextBridge.exposeInMainWorld("ai", {
  getSettings: () => electron.ipcRenderer.invoke("ai:get-settings"),
  getMcpCliSetup: () => electron.ipcRenderer.invoke("ai:get-mcp-cli-setup"),
  getMapImageStats: () => electron.ipcRenderer.invoke("ai:get-map-image-stats"),
  updateSettings: (partial) => electron.ipcRenderer.invoke("ai:update-settings", partial),
  testConnection: () => electron.ipcRenderer.invoke("ai:test-connection"),
  testMcp: () => electron.ipcRenderer.invoke("ai:test-mcp"),
  testProxy: () => electron.ipcRenderer.invoke("ai:test-proxy"),
  testGenerate: (prompt) => electron.ipcRenderer.invoke("ai:test-generate", { prompt }),
  generateTitle: (payload) => electron.ipcRenderer.invoke("ai:generate-title", payload),
  continueWriting: (payload) => electron.ipcRenderer.invoke("ai:continue-writing", payload),
  previewContinuePrompt: (payload) => electron.ipcRenderer.invoke("ai:preview-continue-prompt", payload),
  checkConsistency: (payload) => electron.ipcRenderer.invoke("ai:check-consistency", payload),
  askNovel: (payload) => electron.ipcRenderer.invoke("ai:ask-novel", payload),
  previewNovelAskPrompt: (payload) => electron.ipcRenderer.invoke("ai:preview-novel-ask-prompt", payload),
  generateCreativeAssets: (payload) => electron.ipcRenderer.invoke("ai:generate-creative-assets", payload),
  previewCreativeAssetsPrompt: (payload) => electron.ipcRenderer.invoke("ai:preview-creative-assets-prompt", payload),
  validateCreativeAssetsDraft: (payload) => electron.ipcRenderer.invoke("ai:validate-creative-assets", payload),
  confirmCreativeAssets: (payload) => electron.ipcRenderer.invoke("ai:confirm-creative-assets", payload),
  generateMapImage: (payload) => electron.ipcRenderer.invoke("ai:generate-map-image", payload),
  previewMapPrompt: (payload) => electron.ipcRenderer.invoke("ai:preview-map-prompt", payload),
  rebuildChapterSummary: (chapterId) => electron.ipcRenderer.invoke("ai:rebuild-chapter-summary", { chapterId }),
  executeAction: (actionId, payload) => electron.ipcRenderer.invoke("ai:execute-action", { actionId, payload }),
  openClawInvoke: (name, args) => electron.ipcRenderer.invoke("ai:openclaw-invoke", { name, arguments: args }),
  openClawMcpInvoke: (name, args) => electron.ipcRenderer.invoke("ai:openclaw-mcp-invoke", { name, arguments: args }),
  openClawSkillInvoke: (name, input) => electron.ipcRenderer.invoke("ai:openclaw-skill-invoke", { name, input })
});
electron.contextBridge.exposeInMainWorld("automation", {
  invoke: (method, params, origin) => electron.ipcRenderer.invoke("automation:invoke", { method, params, origin }),
  onDataChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    electron.ipcRenderer.on("automation:data-changed", listener);
    return () => electron.ipcRenderer.removeListener("automation:data-changed", listener);
  }
});
