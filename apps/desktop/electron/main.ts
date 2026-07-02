import { app, BrowserWindow, ipcMain, dialog, nativeImage, protocol, net, session } from 'electron'
import { initDb, db, ensureDbSchema } from '@novel-editor/core'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { execSync } from 'child_process'
import fs from 'fs'
import * as searchIndex from './search/searchIndex'
import { AiService } from './ai/AiService'
import type { RagEvidenceSourceType } from './ai/rag/types'
import { registerRagSummaryIndexRefresh, scheduleChapterSummaryRebuild } from './ai/summary/chapterSummary'
import { formatAiErrorForDisplay, normalizeAiError } from './ai/errors'
import { devLog, devLogError, initDevLogger, isDevDebugEnabled, redactForLog } from './debug/devLogger'
import { AutomationService } from './automation/AutomationService'
import { AutomationServer } from './automation/AutomationServer'
import { readNovelFileAsStructure } from './importers/novelImport'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The built directory structure
process.env.APP_ROOT = path.join(__dirname, '..')

// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

// Global error handling - ensure process exits on uncaught errors
process.on('uncaughtException', (error) => {
    devLogError('Main.uncaughtException', error);
    console.error('[Main] Uncaught Exception:', error);
    app.quit();
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    devLogError('Main.unhandledRejection', reason, { promise: String(promise) });
    console.error('[Main] Unhandled Rejection at:', promise, 'reason:', reason);
    app.quit();
    process.exit(1);
});

let win: BrowserWindow | null
let consolePatched = false
const PACKAGED_APP_NAME = '云梦小说编辑器';
const DEV_APP_NAME = 'Novel Editor Dev';

function resolveWindowsAppUserModelId(): string {
    if (app.isPackaged && process.platform === 'win32') {
        return process.execPath;
    }

    return 'com.noveleditor.app';
}

function isPortableMode(): boolean {
    return app.isPackaged && typeof process.env.PORTABLE_EXECUTABLE_DIR === 'string' && process.env.PORTABLE_EXECUTABLE_DIR.length > 0;
}

function getLegacyPackagedDataDir(): string {
    return path.join(path.dirname(app.getPath('exe')), 'data');
}

function getPortableDataDir(): string {
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
    if (!portableDir) {
        return getLegacyPackagedDataDir();
    }
    return path.join(portableDir, 'data');
}

function copyDirectoryContentsIfMissing(sourceDir: string, targetDir: string): void {
    if (!fs.existsSync(sourceDir)) return;
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
        const sourcePath = path.join(sourceDir, entry.name);
        const targetPath = path.join(targetDir, entry.name);

        if (fs.existsSync(targetPath)) {
            continue;
        }

        if (entry.isDirectory()) {
            fs.cpSync(sourcePath, targetPath, { recursive: true });
            continue;
        }

        fs.copyFileSync(sourcePath, targetPath);
    }
}

function migrateLegacyInstalledDataToUserData(): void {
    if (!app.isPackaged || isPortableMode()) {
        return;
    }

    const legacyDataDir = getLegacyPackagedDataDir();
    const targetDataDir = app.getPath('userData');
    const legacyDbPath = path.join(legacyDataDir, 'novel_editor.db');
    const targetDbPath = path.join(targetDataDir, 'novel_editor.db');

    if (!fs.existsSync(legacyDbPath) || fs.existsSync(targetDbPath)) {
        return;
    }

    copyDirectoryContentsIfMissing(legacyDataDir, targetDataDir);
    console.log('[Main] Migrated legacy packaged data from exe/data to userData.');
}

function resolveWindowIcon(): string | undefined {
    if (app.isPackaged) {
        const packagedIcon = path.join(process.resourcesPath, 'icon_ink_pen_256.ico');
        return fs.existsSync(packagedIcon) ? packagedIcon : undefined;
    }

    const devIcon = path.join(process.env.APP_ROOT || '', 'build', 'icon_ink_pen_256.ico');
    if (fs.existsSync(devIcon)) {
        return devIcon;
    }

    const fallbackIcon = path.join(process.env.VITE_PUBLIC || '', 'electron-vite.svg');
    return fs.existsSync(fallbackIcon) ? fallbackIcon : undefined;
}

function resolveDefaultUserDataPath(): string {
    const appDataPath = app.getPath('appData');
    if (app.isPackaged) {
        return path.join(appDataPath, PACKAGED_APP_NAME);
    }
    return path.join(appDataPath, '@novel-editor', 'desktop-dev');
}

type AiDiagCommand =
    | { action: 'smoke'; kind: 'mcp' | 'skill'; json: boolean; dbPath?: string; userDataPath?: string }
    | { action: 'coverage'; json: boolean; dbPath?: string; userDataPath?: string };

type McpCliSetupPayload = {
    commandPath: string;
    launcherExists: boolean;
    command: string;
    args: string[];
    codexToml: string;
    claudeCommand: string;
    jsonConfig: string;
};

type AutomationRuntimeDescriptor = {
    version: number;
    port: number;
    token: string;
    pid: number;
    startedAt: string;
};

function quoteWindowsArg(value: string): string {
    if (!value) return '""';
    if (!/[ \t"]/u.test(value)) return value;
    return `"${value.replace(/"/gu, '\\"')}"`;
}

function resolveMcpLauncherPath(): string {
    if (app.isPackaged) {
        if (process.platform === 'win32') {
            return path.join(process.resourcesPath, 'mcp', 'novel-editor-mcp.cmd');
        }
        return path.join(process.resourcesPath, 'mcp', 'novel-editor-mcp.mjs');
    }

    if (process.platform === 'win32') {
        return path.join(process.env.APP_ROOT || '', 'scripts', 'novel-editor-mcp.cmd');
    }
    return path.join(process.env.APP_ROOT || '', 'scripts', 'novel-editor-mcp.mjs');
}

function buildMcpCliSetupPayload(): McpCliSetupPayload {
    const commandPath = resolveMcpLauncherPath();
    const launcherExists = fs.existsSync(commandPath);
    const serverName = 'novel_editor';
    const startupTimeoutSec = 60;
    const toolTimeoutSec = 120;

    const command = process.platform === 'win32' ? 'cmd' : 'node';
    const args = process.platform === 'win32' ? ['/c', commandPath] : [commandPath];
    const codexToml = process.platform === 'win32'
        ? [
            `[mcp_servers.${serverName}]`,
            'command = "cmd"',
            `args = ["/c", "${commandPath.replace(/\\/gu, '\\\\')}"]`,
            `startup_timeout_sec = ${startupTimeoutSec}`,
            `tool_timeout_sec = ${toolTimeoutSec}`,
        ].join('\n')
        : [
            `[mcp_servers.${serverName}]`,
            'command = "node"',
            `args = ["${commandPath}"]`,
            `startup_timeout_sec = ${startupTimeoutSec}`,
            `tool_timeout_sec = ${toolTimeoutSec}`,
        ].join('\n');
    const claudeCommand = process.platform === 'win32'
        ? `claude mcp add novel-editor --scope local -- cmd /c ${quoteWindowsArg(commandPath)}`
        : `claude mcp add novel-editor --scope local -- node ${quoteWindowsArg(commandPath)}`;
    const jsonConfig = JSON.stringify(
        {
            mcpServers: {
                [serverName]: {
                    command,
                    args,
                },
            },
        },
        null,
        2,
    );

    return {
        commandPath,
        launcherExists,
        command,
        args,
        codexToml,
        claudeCommand,
        jsonConfig,
    };
}

function getAutomationRuntimePath(): string {
    return path.join(app.getPath('userData'), 'automation', 'runtime.json');
}

function readAutomationRuntimeDescriptor(): AutomationRuntimeDescriptor {
    const runtimePath = getAutomationRuntimePath();
    if (!fs.existsSync(runtimePath)) {
        throw new Error(`Automation runtime file not found: ${runtimePath}`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
    } catch (error: any) {
        throw new Error(`Failed to parse automation runtime: ${error?.message || 'unknown error'}`);
    }
    const runtime = parsed as Partial<AutomationRuntimeDescriptor>;
    if (!runtime || typeof runtime !== 'object') {
        throw new Error('Automation runtime is empty');
    }
    if (!Number.isFinite(runtime.port) || !runtime.port || runtime.port <= 0) {
        throw new Error('Automation runtime port is invalid');
    }
    if (typeof runtime.token !== 'string' || !runtime.token.trim()) {
        throw new Error('Automation runtime token is invalid');
    }
    return {
        version: Number(runtime.version || 1),
        port: Number(runtime.port),
        token: runtime.token,
        pid: Number(runtime.pid || 0),
        startedAt: String(runtime.startedAt || ''),
    };
}

async function invokeAutomationForHealth(runtime: AutomationRuntimeDescriptor): Promise<{ ok: boolean; code?: string; message?: string; data?: unknown }> {
    const payload = {
        method: 'novel.list',
        params: {},
        origin: 'desktop-ui',
    };
    const body = JSON.stringify(payload);

    return await new Promise((resolve, reject) => {
        const request = http.request(
            {
                hostname: '127.0.0.1',
                port: runtime.port,
                path: '/invoke',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body, 'utf8'),
                    Authorization: `Bearer ${runtime.token}`,
                },
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
                response.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    try {
                        resolve(JSON.parse(text));
                    } catch (error: any) {
                        reject(new Error(`Automation health response parse failed: ${error?.message || 'unknown error'}`));
                    }
                });
            },
        );

        request.setTimeout(8000, () => {
            request.destroy(new Error('Automation health request timeout'));
        });
        request.on('error', (error) => reject(error));
        request.write(body);
        request.end();
    });
}

async function testNovelEditorMcpBridge(): Promise<{ ok: boolean; detail: string }> {
    const setup = buildMcpCliSetupPayload();
    if (!setup.launcherExists) {
        return { ok: false, detail: `MCP launcher missing: ${setup.commandPath}` };
    }

    let runtime: AutomationRuntimeDescriptor;
    try {
        runtime = readAutomationRuntimeDescriptor();
    } catch (error: any) {
        return { ok: false, detail: error?.message || 'Automation runtime unavailable' };
    }

    try {
        const response = await invokeAutomationForHealth(runtime);
        if (!response?.ok) {
            return {
                ok: false,
                detail: `Automation invoke failed: ${response?.code || 'UNKNOWN'} ${response?.message || ''}`.trim(),
            };
        }
        const count = Array.isArray(response.data) ? response.data.length : 0;
        return {
            ok: true,
            detail: `MCP bridge ready. launcher=ok runtime=ok invoke=ok novels=${count}`,
        };
    } catch (error: any) {
        return { ok: false, detail: `Automation invoke error: ${error?.message || 'unknown error'}` };
    }
}

function parseAiDiagCommand(argv: string[]): { command?: AiDiagCommand; error?: string } {
    const markerIndex = argv.indexOf('--ai-diag');
    if (markerIndex < 0) return {};

    const tokens = argv.slice(markerIndex + 1);
    if (tokens.length === 0) {
        return { error: 'Missing diagnostic action. Use: --ai-diag smoke <mcp|skill> [--json] [--db <path>] [--user-data <path>] or --ai-diag coverage [--json] [--db <path>] [--user-data <path>]' };
    }

    const positionals: string[] = [];
    let json = false;
    let dbPath: string | undefined;
    let userDataPath: string | undefined;

    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '--json') {
            json = true;
            continue;
        }
        if (token === '--db') {
            const value = tokens[index + 1];
            if (!value) return { error: 'Missing value for --db' };
            dbPath = value;
            index += 1;
            continue;
        }
        if (token === '--user-data') {
            const value = tokens[index + 1];
            if (!value) return { error: 'Missing value for --user-data' };
            userDataPath = value;
            index += 1;
            continue;
        }
        if (token.startsWith('--')) {
            return { error: `Unknown option: ${token}` };
        }
        positionals.push(token);
    }

    const [action, kind] = positionals;
    if (action === 'coverage') {
        return { command: { action: 'coverage', json, dbPath, userDataPath } };
    }
    if (action === 'smoke') {
        if (kind !== 'mcp' && kind !== 'skill') {
            return { error: 'Smoke mode requires kind: mcp | skill' };
        }
        return { command: { action: 'smoke', kind, json, dbPath, userDataPath } };
    }
    return { error: `Unknown diagnostic action: ${action}` };
}

function formatAiDiagReadable(result: unknown, command: AiDiagCommand): string {
    if (command.action === 'coverage') {
        const output = result as {
            overallCoverage: number;
            totalSupported: number;
            totalRequired: number;
            modules: Array<{ title: string; coverage: number; supportedActions: string[]; requiredActions: string[]; missingActions: string[] }>;
        };
        const lines = [
            `[AI-Diag] Coverage ${output.overallCoverage}% (${output.totalSupported}/${output.totalRequired})`,
            ...output.modules.map((module) => {
                const missing = module.missingActions.length ? ` missing=[${module.missingActions.join(', ')}]` : '';
                return `- ${module.title}: ${module.coverage}% (${module.supportedActions.length}/${module.requiredActions.length})${missing}`;
            }),
        ];
        return lines.join('\n');
    }

    const output = result as {
        ok: boolean;
        kind: 'mcp' | 'skill';
        detail: string;
        missingActions: string[];
        checks: Array<{ actionId: string; ok: boolean; skipped?: boolean; detail: string }>;
    };
    const lines = [
        `[AI-Diag] Smoke ${output.kind.toUpperCase()} ${output.ok ? 'PASSED' : 'FAILED'}`,
        `detail: ${output.detail}`,
        output.missingActions.length ? `missingActions: ${output.missingActions.join(', ')}` : 'missingActions: none',
        ...output.checks.map((check) => {
            const tag = check.skipped ? 'SKIPPED' : (check.ok ? 'OK' : 'FAILED');
            return `- [${tag}] ${check.actionId}: ${check.detail}`;
        }),
    ];
    return lines.join('\n');
}

async function runAiDiagCommand(aiService: AiService, command: AiDiagCommand): Promise<number> {
    const result = command.action === 'coverage'
        ? aiService.getCapabilityCoverage()
        : await aiService.testOpenClawSmoke({ kind: command.kind });

    if (command.json) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        console.log(formatAiDiagReadable(result, command));
    }

    if (command.action === 'smoke' && !(result as { ok: boolean }).ok) {
        return 1;
    }
    return 0;
}

function patchDevConsoleLogging(): void {
    if (!isDevDebugEnabled() || consolePatched) return;
    consolePatched = true;

    const originalError = console.error.bind(console);
    const originalWarn = console.warn.bind(console);

    console.error = (...args: unknown[]) => {
        devLog('ERROR', 'console.error', 'console.error called', { args: redactForLog(args) });
        originalError(...args);
    };

    console.warn = (...args: unknown[]) => {
        devLog('WARN', 'console.warn', 'console.warn called', { args: redactForLog(args) });
        originalWarn(...args);
    };
}

function logAiIpcError(channel: string, payload: unknown, error: unknown): void {
    const normalized = normalizeAiError(error);
    devLogError(`Main.${channel}`, error, {
        payload: redactForLog(payload),
        normalizedError: normalized,
        displayMessage: formatAiErrorForDisplay(normalized.code, normalized.message),
    });
}

const aiDiagParse = parseAiDiagCommand(process.argv);

async function applyProxySettings(settings: any): Promise<void> {
    const proxy = settings?.proxy;
    if (!proxy || !session.defaultSession) return;

    const clearEnvProxy = () => {
        delete process.env.HTTP_PROXY;
        delete process.env.http_proxy;
        delete process.env.HTTPS_PROXY;
        delete process.env.https_proxy;
        delete process.env.ALL_PROXY;
        delete process.env.all_proxy;
        delete process.env.NO_PROXY;
        delete process.env.no_proxy;
    };

    const setEnvProxy = () => {
        if (proxy.httpProxy) {
            process.env.HTTP_PROXY = proxy.httpProxy;
            process.env.http_proxy = proxy.httpProxy;
        }
        if (proxy.httpsProxy) {
            process.env.HTTPS_PROXY = proxy.httpsProxy;
            process.env.https_proxy = proxy.httpsProxy;
        }
        if (proxy.allProxy) {
            process.env.ALL_PROXY = proxy.allProxy;
            process.env.all_proxy = proxy.allProxy;
        }
        if (proxy.noProxy) {
            process.env.NO_PROXY = proxy.noProxy;
            process.env.no_proxy = proxy.noProxy;
        }
    };

    if (proxy.mode === 'off') {
        await session.defaultSession.setProxy({ mode: 'direct' });
        clearEnvProxy();
        return;
    }

    if (proxy.mode === 'custom') {
        const rules = [proxy.allProxy, proxy.httpsProxy, proxy.httpProxy]
            .filter((value: string | undefined) => Boolean(value))
            .join(';');

        await session.defaultSession.setProxy({
            mode: rules ? 'fixed_servers' : 'direct',
            proxyRules: rules,
            proxyBypassRules: proxy.noProxy || '',
        });
        clearEnvProxy();
        setEnvProxy();
        return;
    }

    // system mode
    await session.defaultSession.setProxy({ mode: 'system' });
    clearEnvProxy();
}

function createWindow() {
    const isDevMode = !app.isPackaged;
    const icon = resolveWindowIcon();
    win = new BrowserWindow({
        width: 1200,
        height: 800,
        ...(icon ? { icon } : {}),
        webPreferences: {
            preload: path.join(__dirname, 'preload.mjs'),
            devTools: isDevMode,
        },
        // Win11 style & White Screen Fix
        frame: true,
        titleBarStyle: 'default',
        backgroundColor: '#0a0a0f', // Match App Theme
        show: false, // Wait for ready-to-show
        autoHideMenuBar: true // Hide default menu bar
    })

    win.once('ready-to-show', () => {
        win?.show()
    })

    // Test active push message to Renderer-process.
    win.webContents.on('did-finish-load', () => {
        win?.webContents.send('main-process-message', (new Date).toLocaleString())
    })

    win.webContents.on('devtools-opened', () => {
        if (!isDevMode) {
            win?.webContents.closeDevTools();
        }
    })

    win.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'F11') {
            win?.setFullScreen(!win.isFullScreen());
            event.preventDefault();
        }

        if (!isDevMode) {
            return;
        }

        if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
            if (win?.webContents.isDevToolsOpened()) {
                win.webContents.closeDevTools()
            } else {
                win?.webContents.openDevTools()
            }
            event.preventDefault()
        }
    })

    if (VITE_DEV_SERVER_URL) {
        win.loadURL(VITE_DEV_SERVER_URL)
    } else {
        // win.loadFile('dist/index.html')
        win.loadFile(path.join(RENDERER_DIST, 'index.html'))
    }

    // Monitor for fullscreen changes to sync renderer state
    win.on('enter-full-screen', () => {
        win?.webContents.send('app:fullscreen-change', true);
    });
    win.on('leave-full-screen', () => {
        win?.webContents.send('app:fullscreen-change', false);
    });
}

// --- IPC Handlers ---
ipcMain.handle('app:toggle-fullscreen', () => {
    if (win) {
        const isFullScreen = win.isFullScreen();
        win.setFullScreen(!isFullScreen);
        return !isFullScreen;
    }
    return false;
});

ipcMain.handle('app:get-user-data-path', () => {
    return app.getPath('userData');
});

ipcMain.handle('db:get-novels', async () => {
    console.log('[Main] Received db:get-novels');
    try {
        return await db.novel.findMany({
            orderBy: { updatedAt: 'desc' }
        });
    } catch (e) {
        console.error('[Main] db:get-novels failed:', e);
        throw e;
    }
})

ipcMain.handle('db:update-novel', async (_, { id, data }: { id: string, data: { title?: string, coverUrl?: string, description?: string, formatting?: string } }) => {
    console.log('[Main] Updating novel:', id, data);
    try {
        return await db.novel.update({
            where: { id },
            data: {
                ...data,
                updatedAt: new Date()
            }
        });
    } catch (e) {
        console.error('[Main] db:update-novel failed:', e);
        throw e;
    }
})

ipcMain.handle('db:delete-novel', async (_, novelId: string) => {
    console.log('[Main] Received db:delete-novel:', novelId);
    try {
        const novel = await db.novel.findUnique({
            where: { id: novelId },
            select: { coverUrl: true }
        });

        if (novel?.coverUrl?.startsWith('covers/')) {
            const coverPath = path.join(app.getPath('userData'), novel.coverUrl);
            if (fs.existsSync(coverPath)) {
                fs.unlinkSync(coverPath);
            }
        }

        await db.novel.delete({
            where: { id: novelId }
        });

        return { ok: true };
    } catch (e) {
        console.error('[Main] db:delete-novel failed:', e);
        throw e;
    }
})

// Novel Cover Upload
ipcMain.handle('db:upload-novel-cover', async (_, novelId: string) => {
    try {
        const result = await dialog.showOpenDialog(win!, {
            title: 'Select Cover Image',
            filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
            properties: ['openFile']
        });

        if (result.canceled || result.filePaths.length === 0) return null;

        const srcPath = result.filePaths[0];
        const ext = path.extname(srcPath);
        const coversDir = path.join(app.getPath('userData'), 'covers');
        if (!fs.existsSync(coversDir)) fs.mkdirSync(coversDir, { recursive: true });

        // Remove old cover if exists
        const novel = await db.novel.findUnique({ where: { id: novelId }, select: { coverUrl: true } });
        if (novel?.coverUrl?.startsWith('covers/')) {
            const oldPath = path.join(app.getPath('userData'), novel.coverUrl);
            if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }

        const fileName = `${novelId}${ext}`;
        const destPath = path.join(coversDir, fileName);
        fs.copyFileSync(srcPath, destPath);

        const relativePath = `covers/${fileName}`;
        await db.novel.update({
            where: { id: novelId },
            data: { coverUrl: relativePath }
        });

        return { path: relativePath };
    } catch (e) {
        console.error('[Main] db:upload-novel-cover failed:', e);
        throw e;
    }
});

// ... (existing update-novel handler) ...

ipcMain.handle('db:get-volumes', async (_, novelId: string) => {
    try {
        return await db.volume.findMany({
            where: { novelId },
            select: {
                id: true,
                title: true,
                order: true,
                novelId: true,
                version: true,
                deleted: true,
                createdAt: true,
                updatedAt: true,
                chapters: {
                    select: {
                        id: true,
                        title: true,
                        order: true,
                        wordCount: true,
                        updatedAt: true,
                    },
                    orderBy: { order: 'asc' }
                }
            },
            orderBy: { order: 'asc' }
        });
    } catch (e) {
        console.error('[Main] db:get-volumes failed:', e);
        throw e;
    }
})

ipcMain.handle('db:create-volume', async (_, { novelId, title }: { novelId: string, title: string }) => {
    try {
        const lastVol = await db.volume.findFirst({
            where: { novelId },
            orderBy: { order: 'desc' }
        });
        const order = (lastVol?.order || 0) + 1;
        return await db.volume.create({
            data: { novelId, title, order }
        });
    } catch (e) {
        console.error('[Main] db:create-volume failed:', e);
        throw e;
    }
})

ipcMain.handle('db:create-chapter', async (_, { volumeId, title, order }: { volumeId: string, title: string, order: number }) => {
    try {
        const chapter = await db.chapter.create({
            data: {
                volumeId,
                title,
                order,
                content: '',
                wordCount: 0
            },
            include: { volume: { select: { novelId: true } } }
        });

        // Update search index
        await searchIndex.indexChapter({ ...chapter, novelId: chapter.volume.novelId });
        void refreshRagChapterIndex(chapter.id, 'create-chapter');

        return chapter;
    } catch (e) {
        console.error('[Main] db:create-chapter failed:', e);
        throw e;
    }
})



ipcMain.handle('db:get-chapter', async (_, id: string) => {
    try {
        return await db.chapter.findUnique({
            where: { id },
            include: { volume: { select: { novelId: true } } }
        });
    } catch (e) {
        console.error('[Main] db:get-chapter failed:', e);
        throw e;
    }
});

ipcMain.handle('db:rename-volume', async (_, { volumeId, title }: { volumeId: string, title: string }) => {
    try {
        const updated = await db.volume.update({
            where: { id: volumeId },
            data: { title }
        });

        // Trigger index update for all chapters in this volume
        const chapters = await db.chapter.findMany({
            where: { volumeId },
            include: { volume: { select: { novelId: true, title: true, order: true } } }
        });

        for (const chapter of chapters) {
            await searchIndex.indexChapter({
                ...chapter,
                novelId: chapter.volume.novelId,
                volumeTitle: chapter.volume.title,
                volumeOrder: chapter.volume.order
            });
            void refreshRagChapterIndex(chapter.id, 'rename-volume');
        }

        return updated;
    } catch (e) {
        console.error('[Main] db:rename-volume failed:', e);
        throw e;
    }
})

ipcMain.handle('db:rename-chapter', async (_, { chapterId, title }: { chapterId: string, title: string }) => {
    try {
        const updated = await db.chapter.update({
            where: { id: chapterId },
            data: { title }
        });

        // Update search index
        const chapterData = await db.chapter.findUnique({
            where: { id: chapterId },
            select: { id: true, title: true, content: true, volumeId: true, order: true, volume: { select: { novelId: true } } }
        });
        if (chapterData && chapterData.volume) {
            await searchIndex.indexChapter({ ...chapterData, novelId: chapterData.volume.novelId });
            void refreshRagChapterIndex(chapterId, 'rename-chapter');
        }

        return updated;
    } catch (e) {
        console.error('[Main] db:rename-chapter failed:', e);
        throw e;
    }
})

ipcMain.handle('db:delete-chapter', async (_, { chapterId }: { chapterId: string }) => {
    try {
        const chapter = await db.chapter.findUnique({
            where: { id: chapterId },
            select: {
                id: true,
                title: true,
                content: true,
                wordCount: true,
                order: true,
                volumeId: true,
                volume: {
                    select: {
                        novelId: true,
                        title: true,
                        order: true,
                    }
                }
            }
        });

        if (!chapter?.volume) {
            throw new Error('Chapter not found');
        }

        const novelId = chapter.volume.novelId;
        const chaptersInNovel = await db.chapter.findMany({
            where: { volume: { novelId } },
            select: {
                id: true,
                title: true,
                content: true,
                order: true,
                volumeId: true,
                volume: {
                    select: {
                        title: true,
                        order: true,
                    }
                }
            },
            orderBy: [
                { volume: { order: 'asc' } },
                { order: 'asc' },
            ],
        });

        const targetIndex = chaptersInNovel.findIndex((item) => item.id === chapterId);
        if (targetIndex === -1) {
            throw new Error('Chapter not found');
        }

        if (chaptersInNovel.length === 1) {
            const [, resetChapter] = await db.$transaction([
                db.novel.update({
                    where: { id: novelId },
                    data: {
                        wordCount: 0,
                        updatedAt: new Date(),
                    }
                }),
                db.chapter.update({
                    where: { id: chapterId },
                    data: {
                        title: '',
                        content: '',
                        wordCount: 0,
                        updatedAt: new Date(),
                    },
                    include: {
                        volume: {
                            select: {
                                novelId: true,
                            }
                        }
                    }
                }),
            ]);

            await searchIndex.indexChapter({
                ...resetChapter,
                novelId,
                volumeTitle: chapter.volume.title,
                volumeOrder: chapter.volume.order,
            });
            void refreshRagChapterIndex(chapterId, 'reset-only-chapter');

            return {
                mode: 'reset' as const,
                chapterId,
                fallbackChapterId: chapterId,
                chapter: resetChapter,
            };
        }

        const fallbackChapterId = chaptersInNovel[targetIndex + 1]?.id ?? chaptersInNovel[targetIndex - 1]?.id ?? null;
        const siblingChapters = chaptersInNovel.filter((item) => item.volumeId === chapter.volumeId && item.id !== chapterId);
        const reorderedSiblings = siblingChapters.map((item, index) => ({
            ...item,
            nextOrder: index + 1,
        }));
        const siblingsNeedingReorder = reorderedSiblings.filter((item) => item.order !== item.nextOrder);

        await db.$transaction([
            db.novel.update({
                where: { id: novelId },
                data: {
                    wordCount: { decrement: chapter.wordCount },
                    updatedAt: new Date(),
                }
            }),
            db.chapter.delete({
                where: { id: chapterId },
            }),
            ...siblingsNeedingReorder.map((item) => db.chapter.update({
                where: { id: item.id },
                data: {
                    order: item.nextOrder,
                    updatedAt: new Date(),
                }
            })),
        ]);

        await searchIndex.removeFromIndex('chapter', chapterId);
        void removeRagChapterIndex(novelId, chapterId, 'delete-chapter');

        for (const item of siblingsNeedingReorder) {
            await searchIndex.indexChapter({
                id: item.id,
                title: item.title,
                content: item.content,
                volumeId: item.volumeId,
                novelId,
                volumeTitle: item.volume?.title,
                order: item.nextOrder,
                volumeOrder: item.volume?.order,
            });
        }

        return {
            mode: 'deleted' as const,
            chapterId,
            fallbackChapterId,
        };
    } catch (e) {
        console.error('[Main] db:delete-chapter failed:', e);
        throw e;
    }
})


ipcMain.handle('db:create-novel', async (_, title: string) => {
    console.log('[Main] Received db:create-novel:', title);
    try {
        const novel = await db.novel.create({
            data: {
                title,
                wordCount: 0,
                volumes: {
                    create: {
                        title: '', // Default empty
                        order: 1,
                        chapters: {
                            create: {
                                title: '', // Default empty
                                content: '',
                                order: 1,
                                wordCount: 0
                            }
                        }
                    }
                }
            }
        });
        return novel;
    } catch (e) {
        console.error('[Main] db:create-novel failed:', e);
        throw e;
    }
})

ipcMain.handle('db:import-novel-file', async () => {
    try {
        const result = await dialog.showOpenDialog(win!, {
            title: 'Import Novel File',
            filters: [
                { name: 'Novel Files', extensions: ['txt', 'docx', 'pdf'] },
                { name: 'Text', extensions: ['txt'] },
                { name: 'Word', extensions: ['docx'] },
                { name: 'PDF', extensions: ['pdf'] },
            ],
            properties: ['openFile']
        });

        if (result.canceled || result.filePaths.length === 0) return null;

        const filePath = result.filePaths[0];
        const imported = await readNovelFileAsStructure(filePath);
        const chapterCount = imported.volumes.reduce((sum, volume) => sum + volume.chapters.length, 0);
        const importedAt = new Date().toISOString();
        const formatting = JSON.stringify({
            importSource: path.basename(filePath),
            importExtension: path.extname(filePath).replace(/^\./, '').toLowerCase(),
            importedAt,
        });

        const createdNovel = await db.$transaction(async (tx) => {
            const novel = await tx.novel.create({
                data: {
                    title: imported.title,
                    wordCount: imported.wordCount,
                    formatting,
                }
            });

            for (const volumeDraft of imported.volumes) {
                const volume = await tx.volume.create({
                    data: {
                        novelId: novel.id,
                        title: volumeDraft.title,
                        order: volumeDraft.order,
                    }
                });

                for (const chapterDraft of volumeDraft.chapters) {
                    await tx.chapter.create({
                        data: {
                            volumeId: volume.id,
                            title: chapterDraft.title,
                            content: chapterDraft.lexicalContent,
                            wordCount: chapterDraft.wordCount,
                            order: chapterDraft.order,
                        }
                    });
                }
            }

            return novel;
        });

        void (async () => {
            try {
                const chapters = await db.chapter.findMany({
                    where: { volume: { novelId: createdNovel.id } },
                    include: {
                        volume: { select: { novelId: true, title: true, order: true } }
                    },
                    orderBy: [{ volume: { order: 'asc' } }, { order: 'asc' }]
                });

                for (const chapter of chapters) {
                    await searchIndex.indexChapter({
                        ...chapter,
                        novelId: chapter.volume.novelId,
                        volumeTitle: chapter.volume.title,
                        volumeOrder: chapter.volume.order,
                    });
                    void refreshRagChapterIndex(chapter.id, 'import-novel-file');
                    scheduleChapterSummaryRebuild(chapter.id);
                }
            } catch (indexError) {
                console.error('[Main] import post-processing failed:', indexError);
            }
        })();

        return {
            novelId: createdNovel.id,
            title: createdNovel.title,
            volumeCount: imported.volumes.length,
            chapterCount,
        };
    } catch (e) {
        console.error('[Main] db:import-novel-file failed:', e);
        throw e;
    }
})


// ...

ipcMain.handle('db:save-chapter', async (_, { chapterId, content }: { chapterId: string, content: string }) => {
    try {
        console.log('[Main] Saving chapter:', chapterId);
        const chapter = await db.chapter.findUnique({
            where: { id: chapterId },
            select: {
                wordCount: true,
                volume: { select: { novelId: true } }
            }
        });
        if (!chapter || !chapter.volume) throw new Error('Chapter or Volume not found');

        const novelId = chapter.volume.novelId;
        const newWordCount = extractTextFromLexical(content).length;
        const delta = newWordCount - chapter.wordCount;

        // Transaction to ensure consistency
        const [, updatedChapter] = await db.$transaction([
            // 1. Update Novel WordCount
            db.novel.update({
                where: { id: novelId },
                data: {
                    wordCount: { increment: delta },
                    updatedAt: new Date()
                }
            }),
            // 2. Update Chapter
            db.chapter.update({
                where: { id: chapterId },
                data: {
                    content,
                    wordCount: newWordCount,
                    updatedAt: new Date()
                }
            })
        ]);

        // 3. Update Search Index
        const chapterData = await db.chapter.findUnique({
            where: { id: chapterId },
            select: { id: true, title: true, content: true, volumeId: true, order: true }
        });
        if (chapterData) {
            await searchIndex.indexChapter({ ...chapterData, novelId });
            void refreshRagChapterIndex(chapterId, 'save-chapter');
        }

        // Async chapter summary refresh (non-blocking)
        scheduleChapterSummaryRebuild(chapterId);

        return updatedChapter;
    } catch (e) {
        console.error('[Main] db:save-chapter failed:', e);
        throw e;
    }
});

// --- Idea IPC ---
ipcMain.handle('db:create-idea', async (_, data: any) => {
    try {
        const { timestamp, tags, ...prismaData } = data;
        const novelId = prismaData.novelId;

        const result = await db.idea.create({
            data: {
                ...prismaData,
                tags: {
                    connectOrCreate: (tags || []).map((tag: string) => ({
                        where: { name_novelId: { name: tag, novelId } },
                        create: { name: tag, novelId }
                    }))
                }
            },
            include: { tags: true }
        }) as any;

        // Map back for frontend
        const mappedResult = {
            ...result,
            tags: result.tags.map((t: any) => t.name),
            timestamp: result.createdAt.getTime()
        };

        // Update search index
        await searchIndex.indexIdea({
            id: result.id,
            content: result.content,
            quote: result.quote,
            novelId: result.novelId,
            chapterId: result.chapterId
        });

        return mappedResult;
    } catch (e) {
        console.error('[Main] db:create-idea failed:', e);
        throw e;
    }
});

ipcMain.handle('db:get-ideas', async (_, novelId: string) => {
    try {
        const ideas = await db.idea.findMany({
            where: { novelId },
            include: { tags: true },
            orderBy: [
                { isStarred: 'desc' },
                { updatedAt: 'desc' }
            ]
        }) as any[];

        return ideas.map((idea: any) => ({
            ...idea,
            tags: idea.tags.map((t: any) => t.name),
            timestamp: idea.createdAt.getTime()
        }));
    } catch (e) {
        console.error('[Main] db:get-ideas failed:', e);
        throw e;
    }
});

ipcMain.handle('db:update-idea', async (_, id: string, data: any) => {
    try {
        const { timestamp, tags, ...updateData } = data;

        // Handle tags update if present
        const finalData = { ...updateData };
        if (tags !== undefined) {
            // We need to know the novelId to scope the tags.
            // Ideally we pass it from frontend, but let's fetch it to be safe.
            const currentIdea = await db.idea.findUnique({ where: { id }, select: { novelId: true } });
            if (currentIdea) {
                const novelId = currentIdea.novelId;
                finalData.tags = {
                    set: [], // Disconnect all existing
                    connectOrCreate: (tags || []).map((tag: string) => ({
                        where: { name_novelId: { name: tag, novelId } },
                        create: { name: tag, novelId }
                    }))
                };
            }
        }

        const result = await db.idea.update({
            where: { id },
            data: {
                ...finalData,
                updatedAt: new Date()
            },
            include: { tags: true }
        }) as any;

        const mappedResult = {
            ...result,
            tags: result.tags.map((t: any) => t.name),
            timestamp: result.createdAt.getTime()
        };

        // Update search index
        await searchIndex.indexIdea({
            id: result.id,
            content: result.content,
            quote: result.quote,
            novelId: result.novelId,
            chapterId: result.chapterId
        });

        return mappedResult;
    } catch (e) {
        console.error('[Main] db:update-idea failed:', e);
        throw e;
    }
});

ipcMain.handle('db:delete-idea', async (_, id: string) => {
    try {
        const result = await db.idea.delete({ where: { id } });
        // Remove from search index
        await searchIndex.removeFromIndex('idea', id);
        return result;
    } catch (e) {
        console.error('[Main] db:delete-idea failed:', e);
        throw e;
    }
});


// Check index status
ipcMain.handle('db:check-index-status', async (_, novelId: string) => {
    try {
        const stats = await searchIndex.getIndexStats(novelId);

        // Get actual counts
        const chapterCount = await db.chapter.count({
            where: { volume: { novelId } }
        });
        const ideaCount = await db.idea.count({
            where: { novelId }
        });

        return {
            indexedChapters: stats.chapters,
            totalChapters: chapterCount,
            indexedIdeas: stats.ideas,
            totalIdeas: ideaCount
        };
    } catch (e) {
        console.error('[Main] db:check-index-status failed:', e);
        throw e;
    }
});

// --- Sync IPC ---
import { SyncManager } from './sync/SyncManager';
const syncManager = new SyncManager();
let aiService!: AiService;
let automationService!: AutomationService;
let automationServer: AutomationServer | null = null;

async function refreshRagChapterIndex(chapterId: string, reason: string): Promise<void> {
    return refreshRagSourceIndex('chapter', chapterId, reason);
}

async function refreshRagSourceIndex(sourceType: RagEvidenceSourceType, sourceId: string, reason: string): Promise<void> {
    try {
        const result = await aiService.upsertRagSourceIndex(sourceType, sourceId, { skipIfNovelNotIndexed: true });
        if (result.skipped) {
            return;
        }
        console.log('[RAG] Source index refreshed:', { sourceType, sourceId, reason, chunks: result.chunks, provider: result.provider, model: result.model });
    } catch (error) {
        console.warn('[RAG] Failed to refresh source index:', { sourceType, sourceId, reason, error });
    }
}

async function removeRagChapterIndex(novelId: string, chapterId: string, reason: string): Promise<void> {
    return removeRagSourceIndex(novelId, 'chapter', chapterId, reason);
}

async function removeRagSourceIndex(novelId: string, sourceType: RagEvidenceSourceType, sourceId: string, reason: string): Promise<void> {
    try {
        const result = await aiService.deleteRagSourceIndex(novelId, sourceType, sourceId);
        console.log('[RAG] Source index removed:', { novelId, sourceType, sourceId, reason, deleted: result.deleted });
    } catch (error) {
        console.warn('[RAG] Failed to remove source index:', { novelId, sourceType, sourceId, reason, error });
    }
}

// --- AI IPC ---
ipcMain.handle('ai:get-settings', async () => {
    try {
        return aiService.getSettings();
    } catch (e) {
        logAiIpcError('ai:get-settings', undefined, e);
        console.error('[Main] ai:get-settings failed:', e);
        throw e;
    }
});

ipcMain.handle('ai:get-map-image-stats', async () => {
    try {
        return aiService.getMapImageStats();
    } catch (e) {
        logAiIpcError('ai:get-map-image-stats', undefined, e);
        console.error('[Main] ai:get-map-image-stats failed:', e);
        throw e;
    }
});

ipcMain.handle('ai:list-actions', async () => {
    try {
        return aiService.listActions();
    } catch (e) {
        logAiIpcError('ai:list-actions', undefined, e);
        console.error('[Main] ai:list-actions failed:', e);
        throw e;
    }
});

ipcMain.handle('ai:get-capability-coverage', async () => {
    try {
        return aiService.getCapabilityCoverage();
    } catch (e) {
        logAiIpcError('ai:get-capability-coverage', undefined, e);
        console.error('[Main] ai:get-capability-coverage failed:', e);
        throw e;
    }
});

ipcMain.handle('ai:get-mcp-manifest', async () => {
    try {
        return aiService.getMcpToolsManifest();
    } catch (e) {
        logAiIpcError('ai:get-mcp-manifest', undefined, e);
        console.error('[Main] ai:get-mcp-manifest failed:', e);
        throw e;
    }
});

ipcMain.handle('ai:get-mcp-cli-setup', async () => {
    try {
        return buildMcpCliSetupPayload();
    } catch (e) {
        logAiIpcError('ai:get-mcp-cli-setup', undefined, e);
        console.error('[Main] ai:get-mcp-cli-setup failed:', e);
        throw e;
    }
});

ipcMain.handle('ai:get-openclaw-manifest', async () => {
    try {
        return aiService.getOpenClawManifest();
    } catch (e) {
        logAiIpcError('ai:get-openclaw-manifest', undefined, e);
        console.error('[Main] ai:get-openclaw-manifest failed:', e);
        throw e;
    }
});

ipcMain.handle('ai:get-openclaw-skill-manifest', async () => {
    try {
        return aiService.getOpenClawSkillManifest();
    } catch (e) {
        logAiIpcError('ai:get-openclaw-skill-manifest', undefined, e);
        console.error('[Main] ai:get-openclaw-skill-manifest failed:', e);
        throw e;
    }
});

ipcMain.handle('ai:update-settings', async (_, partial: any) => {
    try {
        const updated = aiService.updateSettings(partial || {});
        await applyProxySettings(updated);
        return updated;
    } catch (e) {
        logAiIpcError('ai:update-settings', partial, e);
        console.error('[Main] ai:update-settings failed:', e);
        throw e;
    }
});

ipcMain.handle('ai:test-connection', async () => {
    try {
        return await aiService.testConnection();
    } catch (e) {
        logAiIpcError('ai:test-connection', undefined, e);
        console.error('[Main] ai:test-connection failed:', e);
        throw e;
    }
});

ipcMain.handle('ai:test-mcp', async () => {
    try {
        return await testNovelEditorMcpBridge();
    } catch (e) {
        logAiIpcError('ai:test-mcp', undefined, e);
        console.error('[Main] ai:test-mcp failed:', e);
        throw e;
    }
});

ipcMain.handle('ai:test-openclaw-mcp', async () => {
    try {
        return await aiService.testOpenClawMcp();
    } catch (e) {
        logAiIpcError('ai:test-openclaw-mcp', undefined, e);
        console.error('[Main] ai:test-openclaw-mcp failed:', e);
        throw e;
    }
});

ipcMain.handle('ai:test-openclaw-skill', async () => {
    try {
        return await aiService.testOpenClawSkill();
    } catch (e) {
        logAiIpcError('ai:test-openclaw-skill', undefined, e);
        console.error('[Main] ai:test-openclaw-skill failed:', e);
        throw e;
    }
});

ipcMain.handle('ai:test-openclaw-smoke', async (_, payload: { kind?: 'mcp' | 'skill' } | undefined) => {
    try {
        const kind = payload?.kind === 'skill' ? 'skill' : 'mcp';
        return await aiService.testOpenClawSmoke({ kind });
    } catch (e) {
        logAiIpcError('ai:test-openclaw-smoke', payload, e);
        console.error('[Main] ai:test-openclaw-smoke failed:', e);
        throw e;
    }
});

ipcMain.handle('ai:test-proxy', async () => {
    try {
        return await aiService.testProxy();
    } catch (e) {
        logAiIpcError('ai:test-proxy', undefined, e);
        console.error('[Main] ai:test-proxy failed:', e);
        throw e;
    }
});

ipcMain.handle('ai:test-generate', async (_, payload: { prompt?: string } | undefined) => {
    try {
        return await aiService.testGenerate(payload?.prompt);
    } catch (e) {
        logAiIpcError('ai:test-generate', payload, e);
        console.error('[Main] ai:test-generate failed:', e);
        throw e;
    }
});

ipcMain.handle('ai:generate-title', async (_, payload: any) => {
    try {
        return await aiService.generateTitle(payload);
    } catch (e) {
        logAiIpcError('ai:generate-title', payload, e);
        console.error('[Main] ai:generate-title failed:', e);
        throw e;
    }
});

ipcMain.handle('ai:continue-writing', async (_, payload: any) => {
    try {
        return await aiService.continueWriting(payload);
    } catch (e) {
        logAiIpcError('ai:continue-writing', payload, e);
        console.error('[Main] ai:continue-writing failed:', e);
        throw e;
    }
});

ipcMain.handle('ai:preview-continue-prompt', async (_, payload: any) => {
    try {
        return await aiService.previewContinuePrompt(payload);
    } catch (e) {
        logAiIpcError('ai:preview-continue-prompt', payload, e);
        console.error('[Main] ai:preview-continue-prompt failed:', e);
        throw e;
    }
});

ipcMain.handle('ai:check-consistency', async (_, payload: any) => {
    try {
        return await aiService.checkConsistency(payload);
    } catch (e) {
        logAiIpcError('ai:check-consistency', payload, e);
        console.error('[Main] ai:check-consistency failed:', e);
        throw e;
    }
});

ipcMain.handle('ai:ask-novel', async (_, payload: any) => {
    try {
        return await aiService.askNovel(payload);
    } catch (e) {
        logAiIpcError('ai:ask-novel', payload, e);
        console.error('[Main] ai:ask-novel failed:', e);
        throw e;
    }
});

ipcMain.handle('ai:preview-novel-ask-prompt', async (_, payload: any) => {
    try {
        return await aiService.previewNovelAskPrompt(payload);
    } catch (e) {
        logAiIpcError('ai:preview-novel-ask-prompt', payload, e);
        console.error('[Main] ai:preview-novel-ask-prompt failed:', e);
        throw e;
    }
});

ipcMain.handle('ai:generate-creative-assets', async (_, payload: any) => {
    try {
        return await aiService.generateCreativeAssets(payload);
    } catch (e) {
        logAiIpcError('ai:generate-creative-assets', payload, e);
        console.error('[Main] ai:generate-creative-assets failed:', e);
        throw e;
    }
});

ipcMain.handle('ai:preview-creative-assets-prompt', async (_, payload: any) => {
    try {
        return await aiService.previewCreativeAssetsPrompt(payload);
    } catch (e) {
        logAiIpcError('ai:preview-creative-assets-prompt', payload, e);
        console.error('[Main] ai:preview-creative-assets-prompt failed:', e);
        throw e;
    }
});

ipcMain.handle('ai:validate-creative-assets', async (_, payload: any) => {
    try {
        return await aiService.validateCreativeAssetsDraft(payload);
    } catch (e) {
        logAiIpcError('ai:validate-creative-assets', payload, e);
        console.error('[Main] ai:validate-creative-assets failed:', e);
        throw e;
    }
});

ipcMain.handle('ai:confirm-creative-assets', async (_, payload: any) => {
    try {
        return await aiService.confirmCreativeAssets(payload);
    } catch (e) {
        logAiIpcError('ai:confirm-creative-assets', payload, e);
        console.error('[Main] ai:confirm-creative-assets failed:', e);
        throw e;
    }
});

ipcMain.handle('ai:generate-map-image', async (_, payload: any) => {
    try {
        return await aiService.generateMapImage(payload);
    } catch (e) {
        logAiIpcError('ai:generate-map-image', payload, e);
        console.error('[Main] ai:generate-map-image failed:', e);
        const message = e instanceof Error ? e.message : String(e);
        return { ok: false, code: 'UNKNOWN', detail: message };
    }
});

ipcMain.handle('ai:preview-map-prompt', async (_, payload: any) => {
    try {
        return await aiService.previewMapPrompt(payload);
    } catch (e) {
        logAiIpcError('ai:preview-map-prompt', payload, e);
        console.error('[Main] ai:preview-map-prompt failed:', e);
        throw e;
    }
});

ipcMain.handle('ai:rebuild-chapter-summary', async (_, payload: { chapterId?: string }) => {
    try {
        if (!payload?.chapterId) {
            return { ok: false, detail: 'chapterId is required' };
        }
        scheduleChapterSummaryRebuild(payload.chapterId, 'manual');
        return { ok: true, detail: 'summary rebuild scheduled' };
    } catch (e) {
        logAiIpcError('ai:rebuild-chapter-summary', payload, e);
        console.error('[Main] ai:rebuild-chapter-summary failed:', e);
        return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
});

ipcMain.handle('ai:execute-action', async (_, payload: { actionId: string; payload?: unknown }) => {
    try {
        return await aiService.executeAction(payload);
    } catch (e) {
        logAiIpcError('ai:execute-action', payload, e);
        console.error('[Main] ai:execute-action failed:', e);
        throw e;
    }
});

ipcMain.handle('ai:openclaw-invoke', async (_, payload: { name: string; arguments?: unknown }) => {
    try {
        return await aiService.invokeOpenClawTool(payload);
    } catch (e) {
        logAiIpcError('ai:openclaw-invoke', payload, e);
        console.error('[Main] ai:openclaw-invoke failed:', e);
        const normalized = normalizeAiError(e);
        return {
            ok: false,
            code: normalized.code,
            error: formatAiErrorForDisplay(normalized.code, normalized.message),
        };
    }
});

ipcMain.handle('ai:openclaw-mcp-invoke', async (_, payload: { name: string; arguments?: unknown }) => {
    try {
        return await aiService.invokeOpenClawTool(payload);
    } catch (e) {
        logAiIpcError('ai:openclaw-mcp-invoke', payload, e);
        console.error('[Main] ai:openclaw-mcp-invoke failed:', e);
        const normalized = normalizeAiError(e);
        return {
            ok: false,
            code: normalized.code,
            error: formatAiErrorForDisplay(normalized.code, normalized.message),
        };
    }
});

ipcMain.handle('ai:openclaw-skill-invoke', async (_, payload: { name: string; input?: unknown }) => {
    try {
        return await aiService.invokeOpenClawSkill(payload);
    } catch (e) {
        logAiIpcError('ai:openclaw-skill-invoke', payload, e);
        console.error('[Main] ai:openclaw-skill-invoke failed:', e);
        const normalized = normalizeAiError(e);
        return {
            ok: false,
            code: normalized.code,
            error: formatAiErrorForDisplay(normalized.code, normalized.message),
        };
    }
});

ipcMain.handle('automation:invoke', async (_, payload: { method: string; params?: unknown; origin?: 'desktop-ui' | 'unknown' }) => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    try {
        devLog('INFO', 'Main.automation:invoke.start', 'Renderer automation invoke start', {
            requestId,
            method: payload.method,
            origin: payload.origin ?? 'desktop-ui',
            params: redactForLog(payload.params),
        });
        const result = await automationService.invoke(payload.method, payload.params, {
            source: 'renderer',
            origin: payload.origin ?? 'desktop-ui',
            requestId,
        });
        devLog('INFO', 'Main.automation:invoke.success', 'Renderer automation invoke success', {
            requestId,
            method: payload.method,
            elapsedMs: Date.now() - startedAt,
            result: redactForLog(result),
        });
        const dataChangingMethods = new Set([
            'outline.write',
            'character.create_batch',
            'story_patch.apply',
            'worldsetting.create',
            'worldsetting.update',
            'chapter.create',
            'chapter.save',
            'creative_assets.generate_draft',
            'outline.generate_draft',
            'chapter.generate_draft',
            'draft.update',
            'draft.commit',
            'draft.discard',
        ]);
        if (dataChangingMethods.has(payload.method)) {
            win?.webContents.send('automation:data-changed', { method: payload.method });
        }
        return result;
    } catch (e) {
        devLogError('Main.automation:invoke.error', e, {
            requestId,
            method: payload.method,
            elapsedMs: Date.now() - startedAt,
            payload: redactForLog(payload),
        });
        logAiIpcError('automation:invoke', payload, e);
        throw e;
    }
});

ipcMain.handle('sync:pull', async () => {
    try {
        return await syncManager.pull();
    } catch (e) {
        console.error('[Main] sync:pull failed:', e);
        throw e;
    }
});

// --- Backup IPC ---
import { backupService } from './services/BackupService';

ipcMain.handle('backup:export', async (_, password?: string) => {
    try {
        return await backupService.exportData(undefined, password);
    } catch (e) {
        console.error('[Main] backup:export failed:', e);
        throw e;
    }
});

ipcMain.handle('backup:import', async (_, { filePath, password }: { filePath?: string, password?: string }) => {
    try {
        if (!filePath) {
            const result = await dialog.showOpenDialog({
                title: 'Import Backup',
                filters: [{ name: 'Novel Editor Backup', extensions: ['nebak'] }],
                properties: ['openFile']
            });
            if (result.canceled || result.filePaths.length === 0) return { success: false, code: 'CANCELLED' };
            filePath = result.filePaths[0];
        }
        await backupService.importData(filePath, password);
        return { success: true };
    } catch (e: any) {
        console.error('[Main] backup:import failed:', e);
        // Extract error code if possible.
        // BackupService throws "PASSWORD_REQUIRED" or "PASSWORD_INVALID"
        const msg = e.message || e.toString();

        if (msg.includes('PASSWORD_REQUIRED')) {
            return { success: false, code: 'PASSWORD_REQUIRED', filePath };
        }
        if (msg.includes('PASSWORD_INVALID')) {
            return { success: false, code: 'PASSWORD_INVALID', filePath };
        }

        return { success: false, message: msg };
    }
});

ipcMain.handle('backup:get-auto', async () => {
    try {
        return await backupService.getAutoBackups();
    } catch (e) {
        console.error('[Main] backup:get-auto failed:', e);
        throw e;
    }
});

ipcMain.handle('backup:restore-auto', async (_, filename: string) => {
    try {
        await backupService.restoreAutoBackup(filename);
        return true;
    } catch (e) {
        console.error('[Main] backup:restore-auto failed:', e);
        throw e;
    }
});

ipcMain.handle('sync:push', async () => {
    try {
        return await syncManager.push();
    } catch (e) {
        console.error('[Main] sync:push failed:', e);
        throw e;
    }
});

// --- Search IPC ---
ipcMain.handle('db:search', async (_, { novelId, keyword, limit = 20, offset = 0 }) => {
    try {
        return await searchIndex.search(novelId, keyword, limit, offset);
    } catch (e) {
        console.error('[Main] db:search failed:', e);
        throw e;
    }
});

ipcMain.handle('db:rebuild-search-index', async (_, novelId: string) => {
    try {
        return await searchIndex.rebuildIndex(novelId);
    } catch (e) {
        console.error('[Main] db:rebuild-search-index failed:', e);
        throw e;
    }
});

ipcMain.handle('db:get-all-tags', async (_, novelId?: string) => {
    try {
        if (!novelId) return [];
        // @ts-ignore
        const tags = await db.tag.findMany({
            where: { novelId },
            orderBy: { name: 'asc' },
            select: { name: true }
        });
        return tags.map((t: any) => t.name);
    } catch (e) {
        console.error('[Main] db:get-all-tags failed:', e);
        throw e;
    }
});

// --- Story Structure System IPC ---

// PlotLine
ipcMain.handle('db:get-plot-lines', async (_, novelId: string) => {
    try {
        return await (db as any).plotLine.findMany({
            where: { novelId },
            include: {
                points: {
                    include: { anchors: true },
                    orderBy: { order: 'asc' }
                }
            },
            orderBy: { sortOrder: 'asc' }
        });
    } catch (e) {
        console.error('[Main] db:get-plot-lines failed:', e);
        throw e;
    }
});

ipcMain.handle('db:create-plot-line', async (_, data: { novelId: string; name: string; color: string }) => {
    try {
        const maxOrder = await (db as any).plotLine.aggregate({
            where: { novelId: data.novelId },
            _max: { sortOrder: true }
        });
        const order = (maxOrder._max.sortOrder || 0) + 1;

        const created = await (db as any).plotLine.create({
            data: { ...data, sortOrder: order }
        });
        void refreshRagSourceIndex('plotLine', created.id, 'create-plot-line');
        return created;
    } catch (e) {
        console.error('[Main] db:create-plot-line failed. Data:', data, 'Error:', e);
        throw e;
    }
});

ipcMain.handle('db:update-plot-line', async (_, data: { id: string; data: any }) => {
    try {
        const updated = await (db as any).plotLine.update({
            where: { id: data.id },
            data: data.data
        });
        void refreshRagSourceIndex('plotLine', updated.id, 'update-plot-line');
        return updated;
    } catch (e) {
        console.error('[Main] db:update-plot-line failed. ID:', data.id, 'Error:', e);
        throw e;
    }
});

ipcMain.handle('db:delete-plot-line', async (_, id: string) => {
    try {
        const line = await (db as any).plotLine.findUnique({ where: { id }, select: { novelId: true } });
        const deleted = await (db as any).plotLine.delete({ where: { id } });
        if (line?.novelId) {
            void removeRagSourceIndex(line.novelId, 'plotLine', id, 'delete-plot-line');
        }
        return deleted;
    } catch (e) {
        console.error('[Main] db:delete-plot-line failed. ID:', id, 'Error:', e);
        throw e;
    }
});

// PlotPoint
ipcMain.handle('db:create-plot-point', async (_, data: any) => {
    try {
        const { plotLineId } = data;
        const maxOrder = await (db as any).plotPoint.aggregate({
            where: { plotLineId },
            _max: { order: true }
        });
        const order = (maxOrder._max.order || 0) + 1;

        const created = await (db as any).plotPoint.create({
            data: { ...data, order }
        });
        void refreshRagSourceIndex('plotPoint', created.id, 'create-plot-point');
        return created;
    } catch (e) {
        console.error('[Main] db:create-plot-point failed. Data:', data, 'Error:', e);
        throw e;
    }
});

ipcMain.handle('db:update-plot-point', async (_, data: { id: string; data: any }) => {
    try {
        const updated = await (db as any).plotPoint.update({
            where: { id: data.id },
            data: data.data
        });
        void refreshRagSourceIndex('plotPoint', updated.id, 'update-plot-point');
        return updated;
    } catch (e) {
        console.error('[Main] db:update-plot-point failed. ID:', data.id, 'Error:', e);
        throw e;
    }
});

ipcMain.handle('db:delete-plot-point', async (_, id: string) => {
    try {
        const point = await (db as any).plotPoint.findUnique({ where: { id }, select: { novelId: true } });
        const deleted = await (db as any).plotPoint.delete({ where: { id } });
        if (point?.novelId) {
            void removeRagSourceIndex(point.novelId, 'plotPoint', id, 'delete-plot-point');
        }
        return deleted;
    } catch (e) {
        console.error('[Main] db:delete-plot-point failed. ID:', id, 'Error:', e);
        throw e;
    }
});

// PlotPointAnchor
ipcMain.handle('db:create-plot-point-anchor', async (_, data: any) => {
    try {
        return await (db as any).plotPointAnchor.create({ data });
    } catch (e) {
        console.error('[Main] db:create-plot-point-anchor failed. Data:', data, 'Error:', e);
        throw e;
    }
});

ipcMain.handle('db:delete-plot-point-anchor', async (_, id: string) => {
    try {
        return await (db as any).plotPointAnchor.delete({ where: { id } });
    } catch (e) {
        console.error('[Main] db:delete-plot-point-anchor failed. ID:', id, 'Error:', e);
        throw e;
    }
});

ipcMain.handle('db:reorder-plot-lines', async (_, { lineIds }: { lineIds: string[] }) => {
    try {
        const updates = lineIds.map((id, index) =>
            (db as any).plotLine.update({
                where: { id },
                data: { sortOrder: index }
            })
        );
        await (db as any).$transaction(updates);
        return { success: true };
    } catch (e) {
        console.error('[Main] db:reorder-plot-lines failed:', e);
        throw e;
    }
});

ipcMain.handle('db:reorder-plot-points', async (_, { plotLineId, pointIds }: { plotLineId: string; pointIds: string[] }) => {
    try {
        const updates = pointIds.map((id, index) =>
            (db as any).plotPoint.update({
                where: { id },
                data: { order: index, plotLineId }
            })
        );
        await (db as any).$transaction(updates);
        for (const id of pointIds) {
            void refreshRagSourceIndex('plotPoint', id, 'reorder-plot-points');
        }
        return { success: true };
    } catch (e) {
        console.error('[Main] db:reorder-plot-points failed:', e);
        throw e;
    }
});

// --- Character & Item System IPC ---

// --- Character Image Upload ---
ipcMain.handle('db:upload-character-image', async (_, { characterId, type }: { characterId: string; type: 'avatar' | 'fullBody' }) => {
    try {
        const result = await dialog.showOpenDialog(win!, {
            title: type === 'avatar' ? 'Select Avatar Image' : 'Select Full Body Image',
            filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
            properties: ['openFile']
        });

        if (result.canceled || result.filePaths.length === 0) return null;

        const srcPath = result.filePaths[0];
        const ext = path.extname(srcPath);
        const charDir = path.join(app.getPath('userData'), 'characters', characterId);
        if (!fs.existsSync(charDir)) fs.mkdirSync(charDir, { recursive: true });

        if (type === 'avatar') {
            const fileName = `avatar${ext}`;
            const destPath = path.join(charDir, fileName);
            // Remove old avatar files
            const existingFiles = fs.readdirSync(charDir).filter(f => f.startsWith('avatar.'));
            existingFiles.forEach(f => { try { fs.unlinkSync(path.join(charDir, f)); } catch { } });
            fs.copyFileSync(srcPath, destPath);

            const relativePath = `characters/${characterId}/${fileName}`;
            await (db as any).character.update({
                where: { id: characterId },
                data: { avatar: relativePath }
            });
            return { path: relativePath };
        } else {
            // Full body image - append to list
            const timestamp = Date.now();
            const fileName = `fullbody_${timestamp}${ext}`;
            const destPath = path.join(charDir, fileName);
            fs.copyFileSync(srcPath, destPath);

            const relativePath = `characters/${characterId}/${fileName}`;

            // Get current list
            const char = await (db as any).character.findUnique({ where: { id: characterId }, select: { fullBodyImages: true } });
            let images: string[] = [];
            try { images = JSON.parse(char?.fullBodyImages || '[]'); } catch { }
            images.push(relativePath);

            await (db as any).character.update({
                where: { id: characterId },
                data: { fullBodyImages: JSON.stringify(images) }
            });
            return { path: relativePath, images };
        }
    } catch (e) {
        console.error('[Main] db:upload-character-image failed:', e);
        throw e;
    }
});

ipcMain.handle('db:delete-character-image', async (_, { characterId, imagePath, type }: { characterId: string; imagePath: string; type: 'avatar' | 'fullBody' }) => {
    try {
        const userDataDir = app.getPath('userData');
        const fullPath = path.resolve(path.join(userDataDir, imagePath));
        if (!fullPath.startsWith(userDataDir + path.sep)) {
            throw new Error('Invalid image path: path traversal detected');
        }
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);

        if (type === 'avatar') {
            await (db as any).character.update({
                where: { id: characterId },
                data: { avatar: null }
            });
        } else {
            const char = await (db as any).character.findUnique({ where: { id: characterId }, select: { fullBodyImages: true } });
            let images: string[] = [];
            try { images = JSON.parse(char?.fullBodyImages || '[]'); } catch { }
            images = images.filter(p => p !== imagePath);
            await (db as any).character.update({
                where: { id: characterId },
                data: { fullBodyImages: JSON.stringify(images) }
            });
        }
    } catch (e) {
        console.error('[Main] db:delete-character-image failed:', e);
        throw e;
    }
});

// Get maps where a character has markers
ipcMain.handle('db:get-character-map-locations', async (_, characterId: string) => {
    try {
        const markers = await (db as any).characterMapMarker.findMany({
            where: { characterId },
            include: {
                map: { select: { id: true, name: true, type: true } }
            }
        });
        return markers.map((m: any) => ({
            mapId: m.map.id,
            mapName: m.map.name,
            mapType: m.map.type
        }));
    } catch (e) {
        console.error('[Main] db:get-character-map-locations failed:', e);
        return [];
    }
});

ipcMain.handle('db:get-characters', async (_, novelId: string) => {
    try {
        return await (db as any).character.findMany({
            where: { novelId },
            include: {
                items: {
                    include: { item: true }
                }
            },
            orderBy: [
                { isStarred: 'desc' },
                { sortOrder: 'asc' }
            ]
        });
    } catch (e) {
        console.error('[Main] db:get-characters failed:', e);
        throw e;
    }
});

ipcMain.handle('db:get-character', async (_, id: string) => {
    try {
        return await (db as any).character.findUnique({
            where: { id },
            include: {
                items: {
                    include: { item: true }
                }
            }
        });
    } catch (e) {
        console.error('[Main] db:get-character failed:', e);
        throw e;
    }
});

ipcMain.handle('db:create-character', async (_, data: any) => {
    try {
        // Ensure profile is stringified if it's an object
        const profileData = typeof data.profile === 'object' ? JSON.stringify(data.profile) : data.profile;
        const created = await (db as any).character.create({
            data: { ...data, profile: profileData }
        });
        void refreshRagSourceIndex('character', created.id, 'create-character');
        return created;
    } catch (e) {
        console.error('[Main] db:create-character failed:', e);
        throw e;
    }
});

ipcMain.handle('db:update-character', async (_, { id, data }: { id: string, data: any }) => {
    try {
        const profileData = typeof data.profile === 'object' ? JSON.stringify(data.profile) : data.profile;
        const updated = await (db as any).character.update({
            where: { id },
            data: { ...data, profile: profileData }
        });
        void refreshRagSourceIndex('character', id, 'update-character');
        return updated;
    } catch (e) {
        console.error('[Main] db:update-character failed:', e);
        throw e;
    }
});

ipcMain.handle('db:delete-character', async (_, id: string) => {
    try {
        const character = await (db as any).character.findUnique({ where: { id }, select: { novelId: true } });
        await (db as any).character.delete({ where: { id } });
        if (character?.novelId) {
            void removeRagSourceIndex(character.novelId, 'character', id, 'delete-character');
        }
    } catch (e) {
        console.error('[Main] db:delete-character failed:', e);
        throw e;
    }
});

ipcMain.handle('db:get-items', async (_, novelId: string) => {
    try {
        return await (db as any).item.findMany({
            where: { novelId },
            orderBy: { sortOrder: 'asc' }
        });
    } catch (e) {
        console.error('[Main] db:get-items failed:', e);
        throw e;
    }
});

ipcMain.handle('db:get-item', async (_, id: string) => {
    try {
        return await (db as any).item.findUnique({ where: { id } });
    } catch (e) {
        console.error('[Main] db:get-item failed:', e);
        throw e;
    }
});

ipcMain.handle('db:create-item', async (_, data: any) => {
    try {
        const maxOrder = await (db as any).item.aggregate({
            where: { novelId: data.novelId },
            _max: { sortOrder: true }
        });
        const sortOrder = (maxOrder._max.sortOrder || 0) + 1;

        const created = await (db as any).item.create({
            data: { ...data, sortOrder }
        });
        void refreshRagSourceIndex('item', created.id, 'create-item');
        return created;
    } catch (e) {
        console.error('[Main] db:create-item failed:', e);
        throw e;
    }
});

ipcMain.handle('db:update-item', async (_, { id, data }: { id: string; data: any }) => {
    try {
        const updated = await (db as any).item.update({
            where: { id },
            data: { ...data, updatedAt: new Date() }
        });
        void refreshRagSourceIndex('item', id, 'update-item');
        return updated;
    } catch (e) {
        console.error('[Main] db:update-item failed:', e);
        throw e;
    }
});

ipcMain.handle('db:delete-item', async (_, id: string) => {
    try {
        const item = await (db as any).item.findUnique({ where: { id }, select: { novelId: true } });
        const deleted = await (db as any).item.delete({ where: { id } });
        if (item?.novelId) {
            void removeRagSourceIndex(item.novelId, 'item', id, 'delete-item');
        }
        return deleted;
    } catch (e) {
        console.error('[Main] db:delete-item failed:', e);
        throw e;
    }
});

ipcMain.handle('db:get-mentionables', async (_, novelId: string) => {
    try {
        const [characters, items, worldSettings, maps] = await Promise.all([
            (db as any).character.findMany({
                where: { novelId },
                select: { id: true, name: true, avatar: true, role: true, isStarred: true },
                orderBy: [
                    { isStarred: 'desc' },
                    { name: 'asc' }
                ]
            }),
            (db as any).item.findMany({
                where: { novelId },
                select: { id: true, name: true, icon: true },
                orderBy: { name: 'asc' }
            }),
            (db as any).worldSetting.findMany({
                where: { novelId },
                select: { id: true, name: true, icon: true, type: true },
                orderBy: { name: 'asc' }
            }),
            (db as any).mapCanvas.findMany({
                where: { novelId },
                select: { id: true, name: true, type: true },
                orderBy: { name: 'asc' }
            }),
        ]);

        return [
            ...characters.map((c: any) => ({ ...c, type: 'character' })),
            ...items.map((i: any) => ({ ...i, type: 'item' })),
            ...worldSettings.map((ws: any) => ({ id: ws.id, name: ws.name, icon: ws.icon, type: 'world', role: ws.type })),
            ...maps.map((m: any) => ({ id: m.id, name: m.name, type: 'map', role: m.type })),
        ];
    } catch (e) {
        console.error('[Main] db:get-mentionables failed:', e);
        throw e;
    }
});

// --- World Settings IPC ---
ipcMain.handle('db:get-world-settings', async (_, novelId: string) => {
    try {
        return await (db as any).worldSetting.findMany({
            where: { novelId },
            orderBy: { sortOrder: 'asc' }
        });
    } catch (e) {
        console.error('[Main] db:get-world-settings failed:', e);
        throw e;
    }
});

ipcMain.handle('db:create-world-setting', async (_, data: { novelId: string; name: string; type?: string }) => {
    try {
        const last = await (db as any).worldSetting.findFirst({
            where: { novelId: data.novelId },
            orderBy: { sortOrder: 'desc' }
        });
        const created = await (db as any).worldSetting.create({
            data: {
                novelId: data.novelId,
                name: data.name,
                type: data.type || 'other',
                sortOrder: (last?.sortOrder || 0) + 1
            }
        });
        void refreshRagSourceIndex('worldSetting', created.id, 'create-world-setting');
        return created;
    } catch (e) {
        console.error('[Main] db:create-world-setting failed:', e);
        throw e;
    }
});

ipcMain.handle('db:update-world-setting', async (_, id: string, data: any) => {
    try {
        const updated = await (db as any).worldSetting.update({
            where: { id },
            data
        });
        void refreshRagSourceIndex('worldSetting', id, 'update-world-setting');
        return updated;
    } catch (e) {
        console.error('[Main] db:update-world-setting failed:', e);
        throw e;
    }
});

ipcMain.handle('db:delete-world-setting', async (_, id: string) => {
    try {
        const world = await (db as any).worldSetting.findUnique({ where: { id }, select: { novelId: true } });
        const deleted = await (db as any).worldSetting.delete({ where: { id } });
        if (world?.novelId) {
            void removeRagSourceIndex(world.novelId, 'worldSetting', id, 'delete-world-setting');
        }
        return deleted;
    } catch (e) {
        console.error('[Main] db:delete-world-setting failed:', e);
        throw e;
    }
});

// --- Map System IPC ---
ipcMain.handle('db:get-maps', async (_, novelId: string) => {
    try {
        return await (db as any).mapCanvas.findMany({
            where: { novelId },
            orderBy: { sortOrder: 'asc' }
        });
    } catch (e) {
        console.error('[Main] db:get-maps failed:', e);
        throw e;
    }
});

ipcMain.handle('db:get-map', async (_, id: string) => {
    try {
        return await (db as any).mapCanvas.findUnique({
            where: { id },
            include: {
                markers: { include: { character: { select: { id: true, name: true, avatar: true, role: true } } } },
                elements: { orderBy: { z: 'asc' } }
            }
        });
    } catch (e) {
        console.error('[Main] db:get-map failed:', e);
        throw e;
    }
});

ipcMain.handle('db:create-map', async (_, data: { novelId: string; name: string; type?: string }) => {
    try {
        return await (db as any).mapCanvas.create({ data });
    } catch (e) {
        console.error('[Main] db:create-map failed:', e);
        throw e;
    }
});

ipcMain.handle('db:update-map', async (_, { id, data }: { id: string; data: any }) => {
    try {
        const { markers, elements, createdAt, updatedAt, ...updateData } = data;
        return await (db as any).mapCanvas.update({ where: { id }, data: updateData });
    } catch (e) {
        console.error('[Main] db:update-map failed:', e);
        throw e;
    }
});

ipcMain.handle('db:delete-map', async (_, id: string) => {
    try {
        // Also clean up background file
        const map = await (db as any).mapCanvas.findUnique({ where: { id }, select: { background: true, novelId: true } });
        if (map?.background) {
            const bgPath = path.join(app.getPath('userData'), map.background);
            if (fs.existsSync(bgPath)) fs.unlinkSync(bgPath);
        }
        return await (db as any).mapCanvas.delete({ where: { id } });
    } catch (e) {
        console.error('[Main] db:delete-map failed:', e);
        throw e;
    }
});

ipcMain.handle('db:upload-map-bg', async (_, mapId: string) => {
    try {
        const map = await (db as any).mapCanvas.findUnique({ where: { id: mapId }, select: { novelId: true, background: true } });
        if (!map) return null;

        const result = await dialog.showOpenDialog(win!, {
            title: 'Select Map Image',
            filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
            properties: ['openFile']
        });

        if (result.canceled || result.filePaths.length === 0) return null;

        const srcPath = result.filePaths[0];
        const ext = path.extname(srcPath);
        const mapsDir = path.join(app.getPath('userData'), 'maps', map.novelId);
        if (!fs.existsSync(mapsDir)) fs.mkdirSync(mapsDir, { recursive: true });

        // Remove old background if exists
        if (map.background) {
            const oldPath = path.join(app.getPath('userData'), map.background);
            if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }

        const fileName = `${mapId}${ext}`;
        const destPath = path.join(mapsDir, fileName);
        fs.copyFileSync(srcPath, destPath);

        const relativePath = `maps/${map.novelId}/${fileName}`;

        // Get image dimensions using Electron's nativeImage
        const img = nativeImage.createFromPath(destPath);
        const imgSize = img.getSize();
        const width = imgSize.width || 1200;
        const height = imgSize.height || 800;

        await (db as any).mapCanvas.update({
            where: { id: mapId },
            data: { background: relativePath, width, height }
        });

        return { path: relativePath, width, height };
    } catch (e) {
        console.error('[Main] db:upload-map-bg failed:', e);
        throw e;
    }
});

// --- Map Marker IPC ---
ipcMain.handle('db:get-map-markers', async (_, mapId: string) => {
    try {
        return await (db as any).characterMapMarker.findMany({
            where: { mapId },
            include: { character: { select: { id: true, name: true, avatar: true, role: true } } }
        });
    } catch (e) {
        console.error('[Main] db:get-map-markers failed:', e);
        throw e;
    }
});

ipcMain.handle('db:create-map-marker', async (_, data: { characterId: string; mapId: string; x: number; y: number; label?: string }) => {
    try {
        return await (db as any).characterMapMarker.create({
            data,
            include: { character: { select: { id: true, name: true, avatar: true, role: true } } }
        });
    } catch (e) {
        console.error('[Main] db:create-map-marker failed:', e);
        throw e;
    }
});

ipcMain.handle('db:update-map-marker', async (_, { id, data }: { id: string; data: { x?: number; y?: number; label?: string } }) => {
    try {
        return await (db as any).characterMapMarker.update({
            where: { id },
            data,
            include: { character: { select: { id: true, name: true, avatar: true, role: true } } }
        });
    } catch (e) {
        console.error('[Main] db:update-map-marker failed:', e);
        throw e;
    }
});

ipcMain.handle('db:delete-map-marker', async (_, id: string) => {
    try {
        return await (db as any).characterMapMarker.delete({ where: { id } });
    } catch (e) {
        console.error('[Main] db:delete-map-marker failed:', e);
        throw e;
    }
});

// --- Map Element IPC ---
ipcMain.handle('db:get-map-elements', async (_, mapId: string) => {
    try {
        return await (db as any).mapElement.findMany({
            where: { mapId },
            orderBy: { z: 'asc' }
        });
    } catch (e) {
        console.error('[Main] db:get-map-elements failed:', e);
        throw e;
    }
});

ipcMain.handle('db:create-map-element', async (_, data: { mapId: string; type: string; x: number; y: number; text?: string; iconKey?: string }) => {
    try {
        return await (db as any).mapElement.create({ data });
    } catch (e) {
        console.error('[Main] db:create-map-element failed:', e);
        throw e;
    }
});

ipcMain.handle('db:update-map-element', async (_, { id, data }: { id: string; data: any }) => {
    try {
        const { createdAt, updatedAt, map, ...updateData } = data;
        return await (db as any).mapElement.update({ where: { id }, data: updateData });
    } catch (e) {
        console.error('[Main] db:update-map-element failed:', e);
        throw e;
    }
});

ipcMain.handle('db:delete-map-element', async (_, id: string) => {
    try {
        return await (db as any).mapElement.delete({ where: { id } });
    } catch (e) {
        console.error('[Main] db:delete-map-element failed:', e);
        throw e;
    }
});


ipcMain.handle('db:get-relationships', async (_, characterId: string) => {
    try {
        const [asSource, asTarget] = await Promise.all([
            (db as any).relationship.findMany({
                where: { sourceId: characterId },
                include: { target: { select: { id: true, name: true, avatar: true, role: true } } }
            }),
            (db as any).relationship.findMany({
                where: { targetId: characterId },
                include: { source: { select: { id: true, name: true, avatar: true, role: true } } }
            })
        ]);
        return [...asSource, ...asTarget];
    } catch (e) {
        console.error('[Main] db:get-relationships failed:', e);
        throw e;
    }
});

ipcMain.handle('db:create-relationship', async (_, data: { sourceId: string; targetId: string; relation: string; description?: string }) => {
    try {
        return await (db as any).relationship.create({
            data,
            include: {
                source: { select: { id: true, name: true, avatar: true, role: true } },
                target: { select: { id: true, name: true, avatar: true, role: true } }
            }
        });
    } catch (e) {
        console.error('[Main] db:create-relationship failed:', e);
        throw e;
    }
});

ipcMain.handle('db:delete-relationship', async (_, id: string) => {
    try {
        return await (db as any).relationship.delete({ where: { id } });
    } catch (e) {
        console.error('[Main] db:delete-relationship failed:', e);
        throw e;
    }
});

// --- Item Ownership IPC ---
ipcMain.handle('db:get-character-items', async (_, characterId: string) => {
    try {
        return await (db as any).itemOwnership.findMany({
            where: { characterId },
            include: { item: true }
        });
    } catch (e) {
        console.error('[Main] db:get-character-items failed:', e);
        throw e;
    }
});

ipcMain.handle('db:add-item-to-character', async (_, data: { characterId: string; itemId: string; note?: string }) => {
    try {
        const created = await (db as any).itemOwnership.create({
            data,
            include: { item: true }
        });
        void refreshRagSourceIndex('character', data.characterId, 'add-item-to-character');
        return created;
    } catch (e) {
        console.error('[Main] db:add-item-to-character failed:', e);
        throw e;
    }
});

ipcMain.handle('db:remove-item-from-character', async (_, id: string) => {
    try {
        const ownership = await (db as any).itemOwnership.findUnique({ where: { id }, select: { characterId: true } });
        const deleted = await (db as any).itemOwnership.delete({ where: { id } });
        if (ownership?.characterId) {
            void refreshRagSourceIndex('character', ownership.characterId, 'remove-item-from-character');
        }
        return deleted;
    } catch (e) {
        console.error('[Main] db:remove-item-from-character failed:', e);
        throw e;
    }
});

ipcMain.handle('db:update-item-ownership', async (_, id: string, data: { note?: string }) => {
    try {
        const updated = await (db as any).itemOwnership.update({
            where: { id },
            data,
            include: { item: true }
        });
        void refreshRagSourceIndex('character', updated.characterId, 'update-item-ownership');
        return updated;
    } catch (e) {
        console.error('[Main] db:update-item-ownership failed:', e);
        throw e;
    }
});

// --- Data Aggregation IPC ---

// Character Timeline (Story Mentions from PlotPoints via Anchors)
ipcMain.handle('db:get-character-timeline', async (_, characterId: string) => {
    try {
        const character = await (db as any).character.findUnique({ where: { id: characterId }, select: { name: true, novelId: true } });
        if (!character) return [];

        // PlotPoint → PlotPointAnchor → Chapter
        const anchors = await (db as any).plotPointAnchor.findMany({
            where: {
                plotPoint: {
                    novelId: character.novelId,
                    description: { contains: `@${character.name}` }
                }
            },
            include: {
                plotPoint: { select: { title: true, description: true, plotLine: { select: { name: true } } } },
                chapter: { select: { id: true, title: true, order: true, volume: { select: { title: true, order: true } } } }
            },
            orderBy: [{ chapter: { volume: { order: 'asc' } } }, { chapter: { order: 'asc' } }]
        });

        // Deduplicate by chapterId
        const seen = new Set<string>();
        return anchors
            .filter((a: any) => a.chapter && !seen.has(a.chapter.id) && seen.add(a.chapter.id))
            .map((a: any) => ({
                chapterId: a.chapter.id,
                chapterTitle: a.chapter.title,
                volumeTitle: a.chapter.volume.title,
                order: a.chapter.order,
                volumeOrder: a.chapter.volume.order,
                snippet: a.plotPoint.description?.substring(0, 100) || a.plotPoint.title
            }));
    } catch (e) {
        console.error('[Main] db:get-character-timeline failed:', e);
        throw e;
    }
});

// Helper to extract plain text from Lexical JSON
function extractTextFromLexical(jsonString: string): string {
    if (!jsonString) return '';
    try {
        const content = JSON.parse(jsonString);
        if (!content.root) return jsonString; // Fallback if not Lexical JSON

        const texts: string[] = [];
        const traverse = (node: any) => {
            if (node.text) {
                texts.push(node.text);
            }
            if (node.children && Array.isArray(node.children)) {
                node.children.forEach(traverse);
            }
            // Add space for block elements to prevent words merging
            if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'quote') {
                texts.push(' ');
            }
        };
        traverse(content.root);
        return texts.join('').replace(/\s+/g, ' ').trim();
    } catch (e) {
        return jsonString; // Return raw if parsing fails
    }
}

// Character Chapter Appearances (Name search in chapter content)
ipcMain.handle('db:get-character-chapter-appearances', async (_, characterId: string) => {
    try {
        const character = await (db as any).character.findUnique({ where: { id: characterId }, select: { name: true, novelId: true } });
        if (!character) return [];

        const chapters = await (db as any).chapter.findMany({
            where: {
                volume: { novelId: character.novelId },
                // Use LIKE for rough match on JSON string (imperfect but fast first filter)
                content: { contains: character.name }
            },
            select: {
                id: true, title: true, order: true, content: true,
                volume: { select: { title: true, order: true } }
            },
            orderBy: [{ volume: { order: 'asc' } }, { order: 'asc' }]
        });

        return chapters.map((ch: any) => {
            const plainText = extractTextFromLexical(ch.content || '');
            let snippet = '';

            // Search in plain text
            const idx = plainText.indexOf(character.name);
            if (idx >= 0) {
                const start = Math.max(0, idx - 30);
                const end = Math.min(plainText.length, idx + character.name.length + 50);
                snippet = (start > 0 ? '...' : '') + plainText.substring(start, end) + (end < plainText.length ? '...' : '');
            } else {
                // Fallback: mostly shouldn't reach here if database filter worked and text extraction is correct
                // But JSON structure might contain name in keys or other non-text parts
                // We only want actual text occurrences. If not found in plain text, skip or return empty snippet.
                // Let's try to return a generic snippet from start if specific name not found in text (e.g. name was in formatting)
                // snippet = plainText.substring(0, 80) + '...';
                // Actually, better to filter this out if not found in text? 
                // The requirement is "if appearance". If name is only in attributes not text, it's not appearance.
                // We will return empty snippet or maybe filter these entries out in frontend? 
                // Backend filter is already applied. Let's return snippet if found, else empty.
            }

            return {
                chapterId: ch.id,
                chapterTitle: ch.title,
                volumeTitle: ch.volume.title,
                order: ch.order,
                volumeOrder: ch.volume.order,
                snippet
            };
        }).filter((item: any) => item.snippet !== ''); // Filter out items where name wasn't found in plain text
    } catch (e) {
        console.error('[Main] db:get-character-chapter-appearances failed:', e);
        throw e;
    }
});

ipcMain.handle('db:get-recent-chapters', async (_, characterName: string, novelId: string, limit: number = 5) => {
    try {
        return await (db as any).chapter.findMany({
            where: {
                volume: { novelId },
                content: { contains: `@${characterName}` }
            },
            select: {
                id: true, title: true, order: true, wordCount: true, updatedAt: true
            },
            orderBy: { updatedAt: 'desc' },
            take: limit
        });
    } catch (e) {
        console.error('[Main] db:get-recent-chapters failed:', e);
        throw e;
    }
});


// --- App Lifecycle ---

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit()
        win = null
    }
})

app.on('before-quit', () => {
    if (automationServer) {
        void automationServer.stop().catch((error) => {
            console.error('[Main] Failed to stop automation server:', error);
        });
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
    }
})

app.whenReady().then(async () => {
    if (aiDiagParse.error) {
        initDevLogger(app.getPath('userData'));
        patchDevConsoleLogging();
        console.error(`[AI-Diag] Invalid arguments: ${aiDiagParse.error}`);
        app.exit(2);
        return;
    }

    app.setAppUserModelId(resolveWindowsAppUserModelId());
    app.setName(app.isPackaged ? PACKAGED_APP_NAME : DEV_APP_NAME);

    const resolvedUserDataPath = aiDiagParse.command?.userDataPath
        ? path.resolve(aiDiagParse.command.userDataPath)
        : resolveDefaultUserDataPath();

    app.setPath('userData', resolvedUserDataPath);

    initDevLogger(app.getPath('userData'));
    patchDevConsoleLogging();
    console.log('[Main] App Ready. Starting DB Setup...');
    console.log('[Main] User Data Path:', app.getPath('userData'));

    if (aiDiagParse.command && app.isPackaged) {
        console.error('[AI-Diag] --ai-diag is only available in development mode.');
        app.exit(1);
        return;
    }

    if (aiDiagParse.command?.userDataPath) {
        console.log('[AI-Diag] userData override:', resolvedUserDataPath);
    }

    // Register custom protocol for serving local files (map backgrounds etc.)
    const userDataRoot = path.resolve(app.getPath('userData'));
    protocol.handle('local-resource', (request) => {
        const relativePath = decodeURIComponent(request.url.replace('local-resource://', ''));
        const fullPath = path.resolve(path.join(userDataRoot, relativePath));
        if (!fullPath.startsWith(userDataRoot + path.sep) && fullPath !== userDataRoot) {
            return new Response('Forbidden', { status: 403 });
        }
        return net.fetch('file:///' + fullPath.replace(/\\/g, '/'));
    });


    // 1. Setup Data Paths
    // Installed package: use userData
    // Portable build: use exe/data
    // Development: use userData
    let dataPath: string;

    if (app.isPackaged && isPortableMode()) {
        dataPath = getPortableDataDir();
    } else {
        dataPath = app.getPath('userData');
    }

    migrateLegacyInstalledDataToUserData();

    const dbPath = aiDiagParse.command?.dbPath
        ? path.resolve(aiDiagParse.command.dbPath)
        : path.join(dataPath, 'novel_editor.db');
    const dbUrl = `file:${dbPath}`;

    console.log('[Main] Database Path:', dbPath);

    if (!fs.existsSync(path.dirname(dbPath))) {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }

    // 2. Initialize Core Database (Moved after migration)

    // 3. Auto-migrate in Dev (Synchronous)
    if (!app.isPackaged) {
        const schemaPath = path.resolve(__dirname, '../../../packages/core/prisma/schema.prisma');
        console.log('[Main] Development mode detected (unpackaged). Checking schema at:', schemaPath);

        if (fs.existsSync(schemaPath)) {
            const dbFolder = path.dirname(dbPath);
            if (!fs.existsSync(dbFolder)) {
                fs.mkdirSync(dbFolder, { recursive: true });
            }

            console.log('[Main] Schema found.');

            // FIX: Drop FTS table before migration to prevent Prisma "no such table" errors on shadow tables
            console.log('[Main] Cleaning up FTS tables before migration...');
            initDb(dbUrl); // Initialize client
            try {
                // Use unsafe raw query to drop the virtual table. This also drops shadow tables like search_index_config.
                await db.$executeRawUnsafe('DROP TABLE IF EXISTS search_index;');
                console.log('[Main] FTS tables dropped successfully.');
            } catch (e) {
                console.warn('[Main] Failed to drop FTS table (non-critical):', e);
            }
            // CRITICAL: Disconnect to release SQLite lock before running Prisma CLI
            await (db as any).$disconnect();

            console.log('[Main] Attempting synchronous DB push to:', dbPath);

            // Resolve Prisma Binary
            const prismaPath = path.resolve(__dirname, '../../../packages/core/node_modules/.bin/prisma.cmd');
            console.log('[Main] Using Prisma binary at:', prismaPath);

            if (!fs.existsSync(prismaPath)) {
                console.error('[Main] Prisma binary NOT found at:', prismaPath);
            } else {
                try {
                    const command = `"${prismaPath}" db push --schema="${schemaPath}" --accept-data-loss`;
                    console.log('[Main] Executing command:', command);

                    const output = execSync(command, {
                        env: { ...process.env, DATABASE_URL: dbUrl },
                        cwd: path.resolve(__dirname, '../../../packages/core'),
                        stdio: 'pipe', // Avoid inherit to prevent encoding issues
                        windowsHide: true
                    });
                    console.log('[Main] DB Push output:', output.toString());
                    console.log('[Main] DB Push completed successfully.');
                } catch (error: any) {
                    console.error('[Main] DB Push failed.');
                    if (error.stdout) console.log('[Main] stdout:', error.stdout.toString());
                    if (error.stderr) console.error('[Main] stderr:', error.stderr.toString());
                }
            }
        } else {
            console.warn('[Main] Schema file NOT found at:', schemaPath);
        }
    }

    // 4. Initialize Core Database (Re-connect/Use instance)
    initDb(dbUrl);
    try {
        const schemaApplied = await ensureDbSchema();
        if (schemaApplied) {
            console.log('[Main] Bundled database schema applied successfully.');
        }
    } catch (error) {
        console.error('[Main] Failed to ensure bundled database schema:', error);
        throw error;
    }
    aiService = new AiService(() => app.getPath('userData'));
    registerRagSummaryIndexRefresh((sourceType, sourceId, reason) => {
        void refreshRagSourceIndex(sourceType, sourceId, reason);
    });
    automationService = new AutomationService(aiService, () => app.getPath('userData'));
    automationServer = new AutomationServer(
        automationService,
        () => app.getPath('userData'),
        (method) => {
            win?.webContents.send('automation:data-changed', { method });
        },
    );
    await automationServer.start();

    if (aiDiagParse.command) {
        try {
            const exitCode = await runAiDiagCommand(aiService, aiDiagParse.command);
            await (db as any).$disconnect();
            app.exit(exitCode);
            return;
        } catch (error) {
            console.error('[AI-Diag] Execution failed:', error);
            await (db as any).$disconnect();
            app.exit(1);
            return;
        }
    }

    // 5. Initialize Search Index
    await searchIndex.initSearchIndex();
    console.log('[Main] Search index initialized');

    // 5.5 Apply AI proxy settings before networked AI calls
    try {
        await applyProxySettings(aiService.getSettings());
    } catch (e) {
        console.warn('[Main] Failed to apply AI proxy settings:', e);
    }

    // 6. Create Window
    createWindow();
})


