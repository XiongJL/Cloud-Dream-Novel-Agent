import Ajv from 'ajv';
import catalog from '../../../../contracts/tools/catalog.json';

// The same catalog is bundled into the Python gateway; no independent TS tool list.
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const externalTools = new Map(catalog.tools.flatMap(entry => {
    const profile = (entry.profiles as Record<string, Record<string, unknown>>).external_mcp;
    if (!profile) return [];
    const definition = { ...entry, ...profile };
    return [[entry.name, ajv.compile(definition.inputSchema)] as const];
}));

export function validateExternalMcpCall(method: unknown, params: unknown): void {
    const validate = typeof method === 'string' ? externalTools.get(method) : undefined;
    if (!validate) {
        throw Object.assign(new Error(`Unknown external MCP tool: ${String(method)}`), { code: 'TOOL_NOT_ALLOWED' });
    }
    if (!validate(params ?? {})) {
        throw Object.assign(new Error(ajv.errorsText(validate.errors)), { code: 'INVALID_INPUT' });
    }
}
