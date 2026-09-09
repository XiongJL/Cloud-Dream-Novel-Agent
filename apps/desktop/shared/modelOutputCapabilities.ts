// Output capacity is independent of context capacity. Unknown gateways are
// deliberately unknown; the product safety ceiling is applied separately.
export function resolveModelOutputCapability(model: string): { maximumTokens?: number; source: string } {
    if (/^(?:deepseek\/)?deepseek-v4-(?:flash|pro)$/i.test(model.trim())) {
        return { maximumTokens: 384000, source: 'https://api-docs.deepseek.com/quick_start/pricing/' };
    }
    return { source: 'unknown' };
}

export const PRODUCT_OUTPUT_SAFETY_LIMIT = 32768;
