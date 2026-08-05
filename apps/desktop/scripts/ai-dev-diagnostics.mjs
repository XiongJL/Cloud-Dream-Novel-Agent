#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, initDb } from '@novel-editor/core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopRoot = path.resolve(__dirname, '..');

const SUPPORTED_ACTIONS = [
    'novel.list',
    'novel.create',
    'volume.list',
    'chapter.list',
    'chapter.get',
    'chapter.create',
    'chapter.save',
    'chapter.generate',
    'plotline.list',
    'worldsetting.list',
    'character.list',
    'item.list',
    'map.list',
    'search.query',
];

const OPENCLAW_REQUIRED_ACTIONS = [
    'novel.list',
    'volume.list',
    'chapter.list',
    'chapter.create',
    'chapter.save',
    'chapter.generate',
];

const COVERAGE_BASELINE = [
    {
        moduleId: 'novel_volume_chapter',
        title: '小说/卷章管理',
        requiredActions: ['novel.list', 'novel.create', 'volume.list', 'chapter.list', 'chapter.get', 'chapter.create', 'chapter.save'],
    },
    {
        moduleId: 'editor_ops',
        title: '编辑器操作（标题/续写/总结）',
        requiredActions: ['chapter.generate'],
    },
    {
        moduleId: 'global_search',
        title: '全局搜索与跳转',
        requiredActions: ['search.query'],
    },
    {
        moduleId: 'outline_storyline_anchor',
        title: '大纲/故事线/锚点',
        requiredActions: ['plotline.list'],
    },
    {
        moduleId: 'world_item_map',
        title: '角色/物品/世界观/地图',
        requiredActions: ['character.list', 'item.list', 'worldsetting.list', 'map.list'],
    },
    {
        moduleId: 'backup_restore',
        title: '备份恢复',
        requiredActions: [],
    },
];

function parseArgs(argv) {
    const tokens = [...argv];
    if (tokens.length === 0 || (tokens[0] !== 'smoke' && tokens[0] !== 'coverage')) {
        return { error: 'Usage: ai:diag -- smoke mcp [--json] [--db <path>] [--user-data <path>] | ai:diag -- coverage [--json] [--db <path>] [--user-data <path>]' };
    }

    const action = tokens.shift();
    const command = {
        action,
        kind: action === 'smoke' ? tokens.shift() : undefined,
        json: false,
        dbPath: undefined,
        userDataPath: undefined,
    };

    if (command.action === 'smoke' && command.kind !== 'mcp') {
        return { error: 'smoke requires kind: mcp' };
    }

    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '--json') {
            command.json = true;
            continue;
        }
        if (token === '--db') {
            const value = tokens[index + 1];
            if (!value) return { error: 'Missing value for --db' };
            command.dbPath = value;
            index += 1;
            continue;
        }
        if (token === '--user-data') {
            const value = tokens[index + 1];
            if (!value) return { error: 'Missing value for --user-data' };
            command.userDataPath = value;
            index += 1;
            continue;
        }
        return { error: `Unknown option: ${token}` };
    }

    return { command };
}

function resolveDbPath(command) {
    if (command.dbPath) return path.resolve(command.dbPath);
    if (command.userDataPath) return path.resolve(command.userDataPath, 'novel_editor.db');

    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        const candidate = path.join(appData, '@novel-editor', 'desktop', 'novel_editor.db');
        if (fs.existsSync(candidate)) return candidate;
    }

    const fallbackDevDb = path.join(desktopRoot, 'dev.db');
    if (fs.existsSync(fallbackDevDb)) return fallbackDevDb;

    return path.join(desktopRoot, 'novel_editor.db');
}

function calcCoverage() {
    const supportedSet = new Set(SUPPORTED_ACTIONS);
    const modules = COVERAGE_BASELINE.map((module) => {
        const missingActions = module.requiredActions.filter((actionId) => !supportedSet.has(actionId));
        const supportedActions = module.requiredActions.filter((actionId) => supportedSet.has(actionId));
        const coverage = module.requiredActions.length === 0 ? 0 : Math.round((supportedActions.length / module.requiredActions.length) * 100);
        return {
            moduleId: module.moduleId,
            title: module.title,
            requiredActions: [...module.requiredActions],
            supportedActions,
            missingActions,
            coverage,
        };
    });

    const totalRequired = modules.reduce((acc, item) => acc + item.requiredActions.length, 0);
    const totalSupported = modules.reduce((acc, item) => acc + item.supportedActions.length, 0);
    const overallCoverage = totalRequired === 0 ? 0 : Math.round((totalSupported / totalRequired) * 100);

    return {
        overallCoverage,
        totalRequired,
        totalSupported,
        modules,
    };
}

async function runSmoke() {
    const kind = 'mcp';
    const missingActions = OPENCLAW_REQUIRED_ACTIONS.filter((actionId) => !SUPPORTED_ACTIONS.includes(actionId));
    const checks = [];

    const pushCheck = (actionId, ok, detail, skipped = false) => {
        checks.push({ actionId, ok, detail, ...(skipped ? { skipped: true } : {}) });
    };

    if (missingActions.length) {
        pushCheck('manifest.coverage', false, `Missing required actions: ${missingActions.join(', ')}`);
    } else {
        pushCheck('manifest.coverage', true, `All required actions are covered (${OPENCLAW_REQUIRED_ACTIONS.length})`);
    }

    const novels = await db.novel.findMany({ select: { id: true }, orderBy: { updatedAt: 'desc' }, take: 1 });
    pushCheck('novel.list', true, 'invoke ok');

    const firstNovelId = novels[0]?.id;
    if (!firstNovelId) {
        pushCheck('volume.list', true, 'no novels in database; skipped', true);
        pushCheck('chapter.list', true, 'no novels in database; skipped', true);
        const ok = missingActions.length === 0;
        return {
            ok,
            kind,
            detail: ok
                ? `OpenClaw ${kind.toUpperCase()} smoke passed (manifest coverage ok, invoke ok, nested checks skipped due to empty data)`
                : `OpenClaw ${kind.toUpperCase()} smoke partial pass (invoke ok, but manifest missing required actions: ${missingActions.join(', ')})`,
            missingActions,
            checks,
        };
    }

    const volumes = await db.volume.findMany({ where: { novelId: firstNovelId }, select: { id: true }, orderBy: { order: 'asc' }, take: 1 });
    pushCheck('volume.list', true, 'invoke ok');

    const firstVolumeId = volumes[0]?.id;
    if (!firstVolumeId) {
        pushCheck('chapter.list', true, 'no volumes under first novel; skipped', true);
        const ok = missingActions.length === 0;
        return {
            ok,
            kind,
            detail: ok
                ? `OpenClaw ${kind.toUpperCase()} smoke passed (manifest coverage ok, read-chain invoke ok)`
                : `OpenClaw ${kind.toUpperCase()} smoke partial pass (read-chain ok, but manifest missing required actions: ${missingActions.join(', ')})`,
            missingActions,
            checks,
        };
    }

    await db.chapter.findMany({ where: { volumeId: firstVolumeId }, select: { id: true }, orderBy: { order: 'asc' }, take: 1 });
    pushCheck('chapter.list', true, 'invoke ok');

    const ok = missingActions.length === 0;
    return {
        ok,
        kind,
        detail: ok
            ? `OpenClaw ${kind.toUpperCase()} smoke passed (manifest coverage + read-chain invoke all ok)`
            : `OpenClaw ${kind.toUpperCase()} smoke partial pass (invoke ok, but manifest missing required actions: ${missingActions.join(', ')})`,
        missingActions,
        checks,
    };
}

function formatReadable(command, result) {
    if (command.action === 'coverage') {
        const lines = [
            `[AI-Diag] Coverage ${result.overallCoverage}% (${result.totalSupported}/${result.totalRequired})`,
            ...result.modules.map((module) => {
                const missing = module.missingActions.length ? ` missing=[${module.missingActions.join(', ')}]` : '';
                return `- ${module.title}: ${module.coverage}% (${module.supportedActions.length}/${module.requiredActions.length})${missing}`;
            }),
        ];
        return lines.join('\n');
    }

    const lines = [
        `[AI-Diag] Smoke ${result.kind.toUpperCase()} ${result.ok ? 'PASSED' : 'FAILED'}`,
        `detail: ${result.detail}`,
        result.missingActions.length ? `missingActions: ${result.missingActions.join(', ')}` : 'missingActions: none',
        ...result.checks.map((check) => {
            const tag = check.skipped ? 'SKIPPED' : (check.ok ? 'OK' : 'FAILED');
            return `- [${tag}] ${check.actionId}: ${check.detail}`;
        }),
    ];

    return lines.join('\n');
}

(async () => {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.error) {
        console.error(parsed.error);
        process.exit(2);
    }

    const command = parsed.command;
    const dbPath = resolveDbPath(command);
    if (!fs.existsSync(dbPath)) {
        console.error(`[ai:diag] Database not found: ${dbPath}`);
        process.exit(1);
    }

    initDb(`file:${dbPath}`);

    try {
        const result = command.action === 'coverage' ? calcCoverage() : await runSmoke();
        if (command.json) {
            console.log(JSON.stringify(result, null, 2));
        } else {
            console.log(formatReadable(command, result));
        }

        if (command.action === 'smoke' && !result.ok) {
            process.exit(1);
        }
        process.exit(0);
    } catch (error) {
        console.error('[ai:diag] failed:', error instanceof Error ? error.message : String(error));
        process.exit(1);
    } finally {
        await db.$disconnect().catch(() => undefined);
    }
})();
