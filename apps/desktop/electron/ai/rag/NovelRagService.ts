import type { AiProvider } from '../types';
import type { AiEmbeddingSettings } from '../types';
import { detectRagQuestion } from './intent';
import { collectRagEvidence, getKnownRagEntityNames } from './evidence';
import type { RagAskPayload, RagAskResult, RagCitation, RagPromptBundle } from './types';

function buildRawPromptPreview(systemPrompt: string | undefined, userPrompt: string): string {
    const sections: string[] = [];
    if (systemPrompt?.trim()) {
        sections.push(`[System Prompt]\n${systemPrompt.trim()}`);
    }
    sections.push(`[User Prompt]\n${userPrompt.trim()}`);
    return sections.join('\n\n');
}

function parseConfidence(text: string, evidenceCount: number): 'high' | 'medium' | 'low' {
    const lower = text.toLowerCase();
    if (/不足以判断|资料不足|无法判断|insufficient|not enough/.test(lower)) return 'low';
    if (/confidence\s*[:：]\s*high|置信度\s*[:：]\s*高/.test(lower)) return 'high';
    if (/confidence\s*[:：]\s*low|置信度\s*[:：]\s*低/.test(lower)) return 'low';
    if (evidenceCount >= 5) return 'high';
    if (evidenceCount >= 2) return 'medium';
    return 'low';
}

function extractCitations(answer: string, evidenceIds: string[]): RagCitation[] {
    const found = new Set<string>();
    for (const match of answer.matchAll(/\[?(E\d+)\]?/g)) {
        const id = match[1];
        if (evidenceIds.includes(id)) found.add(id);
    }
    return Array.from(found).map((id) => ({ evidenceId: id, label: `[${id}]` }));
}

export class NovelRagService {
    async buildPromptBundle(payload: RagAskPayload, embeddingSettings?: AiEmbeddingSettings): Promise<RagPromptBundle> {
        const question = String(payload.question || '').trim();
        if (!payload.novelId?.trim()) {
            throw new Error('novelId is required');
        }
        if (!question) {
            throw new Error('question is required');
        }

        const knownEntityNames = await getKnownRagEntityNames(payload.novelId);
        const detection = detectRagQuestion(question, knownEntityNames);
        const collected = await collectRagEvidence({
            novelId: payload.novelId,
            chapterId: payload.chapterId,
            currentContent: payload.currentContent,
            selectedText: payload.selectedText,
            currentLocation: payload.currentLocation,
            detection,
            question,
            maxEvidenceItems: payload.maxEvidenceItems,
            locale: payload.locale,
            embeddingSettings,
        });
        const evidenceBlock = collected.evidence.map((item) => (
            `[${item.id}] ${item.sourceType} | ${item.title}\n${item.excerpt}`
        )).join('\n\n');
        const isZh = (payload.locale || 'zh').startsWith('zh');
        const systemPrompt = isZh
            ? '你是小说编辑器中的 RAG 问答助手。你只能基于 Evidence 中提供的资料回答。如果资料不足，请明确说明不足以判断。请区分“已写事实”“大纲计划”“写作建议”。涉及剧情判断时必须引用证据标签，例如 [E1]。不要编造未提供的设定、章节或人物状态。'
            : 'You are a RAG Q&A assistant inside a novel editor. Answer only from the provided Evidence. If evidence is insufficient, say so clearly. Separate written facts, outline plans, and writing suggestions. Cite evidence labels such as [E1]. Do not invent missing lore, chapters, or character state.';
        const defaultUserPrompt = [
            `Question=${question}`,
            `Intent=${detection.intent}`,
            detection.entityNames.length ? `DetectedEntities=${detection.entityNames.join(', ')}` : 'DetectedEntities=none',
            detection.keywords.length ? `Keywords=${detection.keywords.join(', ')}` : 'Keywords=none',
            payload.selectedText?.trim() ? `SelectedTextProvided=true` : 'SelectedTextProvided=false',
            payload.currentLocation?.trim() ? `CurrentLocation=${payload.currentLocation.trim()}` : '',
            'Evidence=',
            evidenceBlock || '(no relevant evidence found)',
            isZh
                ? 'Output=用简洁中文回答。若能回答，请按“已写事实 / 大纲计划 / 写作建议 / 置信度”组织；没有对应内容可省略该小节。必须引用证据标签。'
                : 'Output=Answer concisely. Organize as Written facts / Outline plans / Writing suggestions / Confidence when applicable. Omit empty sections. Cite evidence labels.',
        ].filter(Boolean).join('\n\n');
        const effectiveUserPrompt = payload.overrideUserPrompt?.trim() ? payload.overrideUserPrompt.trim() : defaultUserPrompt;

        return {
            systemPrompt,
            defaultUserPrompt,
            effectiveUserPrompt,
            intent: detection.intent,
            evidence: collected.evidence,
            citations: collected.evidence.map((item) => ({ evidenceId: item.id, label: `[${item.id}]` })),
            warnings: collected.warnings,
            usedContext: collected.usedContext,
        };
    }

    async preview(payload: RagAskPayload, embeddingSettings?: AiEmbeddingSettings): Promise<RagAskResult> {
        const bundle = await this.buildPromptBundle(payload, embeddingSettings);
        return {
            ok: true,
            question: payload.question,
            intent: bundle.intent,
            answer: '',
            confidence: bundle.evidence.length > 0 ? 'medium' : 'low',
            evidence: bundle.evidence,
            citations: bundle.citations,
            warnings: bundle.warnings,
            usedContext: bundle.usedContext,
            rawPrompt: buildRawPromptPreview(bundle.systemPrompt, bundle.effectiveUserPrompt),
            editableUserPrompt: bundle.defaultUserPrompt,
        };
    }

    async ask(payload: RagAskPayload, provider: AiProvider, settings: { maxTokens?: number; temperature?: number; embeddingSettings?: AiEmbeddingSettings }): Promise<RagAskResult> {
        const bundle = await this.buildPromptBundle(payload, settings.embeddingSettings);
        const response = await provider.generate({
            systemPrompt: bundle.systemPrompt,
            prompt: bundle.effectiveUserPrompt,
            maxTokens: settings.maxTokens,
            temperature: settings.temperature ?? 0.2,
        });
        const evidenceIds = bundle.evidence.map((item) => item.id);
        const citations = extractCitations(response.text, evidenceIds);
        return {
            ok: true,
            question: payload.question,
            intent: bundle.intent,
            answer: response.text,
            confidence: parseConfidence(response.text, bundle.evidence.length),
            evidence: bundle.evidence,
            citations: citations.length > 0 ? citations : bundle.citations.slice(0, 3),
            warnings: bundle.warnings,
            usedContext: bundle.usedContext,
            rawPrompt: buildRawPromptPreview(bundle.systemPrompt, bundle.effectiveUserPrompt),
            editableUserPrompt: bundle.defaultUserPrompt,
        };
    }
}
