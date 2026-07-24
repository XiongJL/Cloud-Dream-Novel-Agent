export function parseFirstJsonObject(text: string): Record<string, unknown> | null {
    const normalized = String(text || '').trim();
    if (!normalized) return null;

    try {
        const direct = JSON.parse(normalized);
        if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
            return direct as Record<string, unknown>;
        }
    } catch {
        // Scan below for the first complete JSON object.
    }

    for (let start = normalized.indexOf('{'); start >= 0; start = normalized.indexOf('{', start + 1)) {
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let index = start; index < normalized.length; index += 1) {
            const character = normalized[index];
            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (character === '\\') {
                    escaped = true;
                } else if (character === '"') {
                    inString = false;
                }
                continue;
            }
            if (character === '"') {
                inString = true;
                continue;
            }
            if (character === '{') depth += 1;
            if (character !== '}') continue;
            depth -= 1;
            if (depth !== 0) continue;
            try {
                const parsed = JSON.parse(normalized.slice(start, index + 1));
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    return parsed as Record<string, unknown>;
                }
            } catch {
                break;
            }
        }
    }
    return null;
}
