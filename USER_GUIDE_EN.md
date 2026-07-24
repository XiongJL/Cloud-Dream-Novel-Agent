# CloudDream Novel Agent User Guide

## 1. Interface Overview
Use the left Activity Bar to switch major views:
- Explorer: volume/chapter management
- Ideas: idea capture and browsing
- Plot: plot lines and plot points
- World: characters/items/world settings/maps
- Search: global search
- AI Workbench: AI draft generation with confirm-to-save flow
- Settings: theme, language, and AI configuration

## 2. Basic Writing Operations
- New volume/chapter: click `+` in Explorer
- Rename: double-click a volume or chapter name
- Open chapter: single-click a chapter
- Auto-save: chapter content is saved automatically while editing
- Formatting: toolbar supports style, alignment, font size, and auto-format

## 3. AI Features

### 3.1 Title Generation
1. Click "Generate Title with AI" near the chapter title.
2. The system proposes candidate titles from current chapter context.
3. Click a candidate to replace the title.

Note: a full staged progress bar for title generation is planned next; current build provides basic loading feedback.

### 3.2 Continue Writing (Recommended Flow)
1. Click "Continue Writing" to open the config modal.
2. Set target length, creativity level, context chapter range, and style/tone.
3. Optionally select one or more idea references.
4. Review generated preview first, then confirm insertion.

Chapter-1 rule: if no outline exists for chapter one, the app guides you to create an outline or write a manual opening first.

### 3.3 AI Workbench
1. Open "AI Workbench" from Activity Bar.
2. Enter your brief (genre, style, conflict, etc.).
3. Generate drafts (outline, characters, items, skills, maps).
4. Edit/delete/select entries in the draft list.
5. Confirm persistence.

Note: validation runs before persistence. If one item fails, the batch is rolled back atomically.

### 3.4 Summary Strategy
- Local summary: fast, no model token cost.
- AI summary: higher quality, consumes model tokens.
- Recommended: use AI summary in manual mode or when a chapter is finished.

### 3.5 AI Key Storage
- `API Key` / `API Token` values are stored only on the current device.
- They are saved in `ai-settings.json` under the app user data directory.
- The app does not write these keys into the novel database.
- Backup/restore does not include these keys. After restoring a backup, you must enter the key again if AI features are needed.

## 4. Common Shortcuts
| Action | Windows/Linux | macOS |
| --- | --- | --- |
| Save | `Ctrl + S` | `Cmd + S` |
| Undo | `Ctrl + Z` | `Cmd + Z` |
| Redo | `Ctrl + Y` | `Cmd + Shift + Z` |
| Find in chapter | `Ctrl + F` | `Cmd + F` |
| Global search | `Ctrl + Shift + F` | `Cmd + Shift + F` |
| New idea | `Ctrl + I` | `Cmd + I` |

## 5. FAQ
- Continuation quality is off: tune context range and style/tone, then regenerate.
- Search misses content: save chapter first and retry.
- Map generation fails: verify model settings and network, then retry.
- AI settings are missing after moving devices or restoring a backup: this is expected because API keys stay local and are not migrated with backups.

