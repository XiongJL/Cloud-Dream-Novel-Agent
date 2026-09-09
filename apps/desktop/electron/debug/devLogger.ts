import fs from 'node:fs';
import path from 'node:path';

export type DevLogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

const DEV_LOG_FILE_NAME = 'debug-dev.log';
const DEV_LOG_MAX_BYTES = 15 * 1024 * 1024;
const REDACTED_VALUE = '***REDACTED***';
const SENSITIVE_KEYS = new Set([
    'authorization',
    'apikey',
    'api_key',
    'api key',
    'token',
    'access_token',
    'refresh_token',
    'contenttext',
    'beforetext',
    'aftertext',
    'currentdocument',
]);

let logFilePath: string | null = null;

export function isDevDebugEnabled(): boolean {
    return process.env.NODE_ENV !== 'production';
}

export function initDevLogger(userDataPath: string): void {
    if (!isDevDebugEnabled()) return;
    logFilePath = path.join(userDataPath, DEV_LOG_FILE_NAME);
    ensureLogFileReady();
}

export function redactForLog(value: unknown): unknown {
    return sanitizeValue(value, new WeakSet<object>());
}

export function devLog(level: DevLogLevel, scope: string, message: string, extra?: unknown): void {
    if (!isDevDebugEnabled()) return;
    const lines = [
        `[${new Date().toISOString()}] [${level}] [${scope}]`,
        `message=${message}`,
        extra === undefined ? '' : `extra=${safeStringify(redactForLog(extra))}`,
        '',
    ].filter(Boolean);
    writeLog(lines.join('\n'));
}

export function devLogError(scope: string, error: unknown, extra?: unknown): void {
    const normalizedError = normalizeError(error);
    devLog('ERROR', scope, normalizedError.message, {
        error: normalizedError,
        ...(extra === undefined ? {} : { extra }),
    });
}

function ensureLogFileReady(): void {
    if (!logFilePath) return;
    const dir = path.dirname(logFilePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(logFilePath)) {
        fs.writeFileSync(logFilePath, '', 'utf8');
    }
}

function writeLog(content: string): void {
    if (!logFilePath) return;
    try {
        ensureLogFileReady();
        const currentBytes = fs.existsSync(logFilePath) ? fs.statSync(logFilePath).size : 0;
        if (currentBytes >= DEV_LOG_MAX_BYTES) {
            fs.writeFileSync(logFilePath, '', 'utf8');
        }
        fs.appendFileSync(logFilePath, `${content}\n`, 'utf8');
    } catch {
        // Debug logging must never break runtime logic.
    }
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

function normalizeError(error: unknown): { name: string; message: string; stack?: string } {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack,
        };
    }

    return {
        name: typeof error,
        message: String(error),
    };
}

function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return value.toString();

    if (value instanceof Error) {
        return normalizeError(value);
    }

    if (Array.isArray(value)) {
        return value.map((item) => sanitizeValue(item, seen));
    }

    if (typeof value === 'object') {
        const objectValue = value as Record<string, unknown>;
        if (seen.has(objectValue)) {
            return '[Circular]';
        }
        seen.add(objectValue);
        const result: Record<string, unknown> = {};
        for (const [key, rawValue] of Object.entries(objectValue)) {
            if (SENSITIVE_KEYS.has(key.toLowerCase())) {
                result[key] = REDACTED_VALUE;
                continue;
            }
            result[key] = sanitizeValue(rawValue, seen);
        }
        seen.delete(objectValue);
        return result;
    }

    return String(value);
}
