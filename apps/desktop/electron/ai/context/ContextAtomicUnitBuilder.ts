import type { SummaryMessageSource } from './AgentConversationSummaryV2';

export type ContextAtomicUnitStatus = 'closed' | 'open' | 'invalid';
export type ContextAtomicUnitKind = 'conversation_turn' | 'structured_interaction';

export interface ContextAtomicStateRef {
    kind:
        | 'user_input'
        | 'input_resolution'
        | 'approval'
        | 'approval_response'
        | 'run'
        | 'run_event'
        | 'tool_result'
        | 'artifact'
        | 'attachment';
    id: string;
    status: 'open' | 'closed';
    messageIds?: string[];
}

export interface ContextAtomicUnit {
    unitId: string;
    kind: ContextAtomicUnitKind;
    sequenceStart: number;
    sequenceEnd: number;
    messageIds: string[];
    stateRefs: ContextAtomicStateRef[];
    status: ContextAtomicUnitStatus;
    reason?: string;
}

export interface ContextAtomicBuildResult {
    units: ContextAtomicUnit[];
    validBoundaryUnitIds: string[];
    blockingUnit?: ContextAtomicUnit;
}

export interface ContextPrefixSelection {
    coveredMessages: SummaryMessageSource[];
    newlyCoveredMessages: SummaryMessageSource[];
    boundaryUnitId?: string;
    recentTailMessages: SummaryMessageSource[];
    blockedBy?: ContextAtomicUnit;
}

function unitId(messages: SummaryMessageSource[], suffix = ''): string {
    const first = messages[0];
    const last = messages[messages.length - 1];
    return `unit:${first?.messageId || 'state'}:${last?.messageId || 'state'}${suffix}`;
}

function invalidUnit(message: SummaryMessageSource, reason: string): ContextAtomicUnit {
    return {
        unitId: unitId([message], ':invalid'),
        kind: 'conversation_turn',
        sequenceStart: message.sequence,
        sequenceEnd: message.sequence,
        messageIds: [message.messageId],
        stateRefs: [],
        status: 'invalid',
        reason,
    };
}

export class ContextAtomicUnitBuilder {
    build(input: {
        messages: SummaryMessageSource[];
        stateRefs?: ContextAtomicStateRef[];
    }): ContextAtomicBuildResult {
        const messages = [...input.messages].sort((left, right) => left.sequence - right.sequence);
        const units: ContextAtomicUnit[] = [];
        const sequenceSet = new Set<number>();
        const messageIdSet = new Set<string>();
        for (const message of messages) {
            if (!Number.isSafeInteger(message.sequence) || message.sequence < 1) {
                units.push(invalidUnit(message, 'Message sequence must be a positive stable integer.'));
                continue;
            }
            if (sequenceSet.has(message.sequence) || messageIdSet.has(message.messageId)) {
                units.push(invalidUnit(message, 'Duplicate message sequence or message ID.'));
                continue;
            }
            sequenceSet.add(message.sequence);
            messageIdSet.add(message.messageId);
        }
        if (units.length) return { units, validBoundaryUnitIds: [], blockingUnit: units[0] };

        let turn: SummaryMessageSource[] = [];
        let hasAssistant = false;
        const flush = () => {
            if (!turn.length) return;
            const status: ContextAtomicUnitStatus = hasAssistant ? 'closed' : 'open';
            units.push({
                unitId: unitId(turn),
                kind: 'conversation_turn',
                sequenceStart: turn[0].sequence,
                sequenceEnd: turn[turn.length - 1].sequence,
                messageIds: turn.map((message) => message.messageId),
                stateRefs: [],
                status,
                ...(status === 'open' ? { reason: 'User turn has no assistant response yet.' } : {}),
            });
            turn = [];
            hasAssistant = false;
        };

        for (const message of messages) {
            if (!turn.length) {
                if (message.role === 'assistant') {
                    units.push(invalidUnit(message, 'Assistant response has no preceding user turn.'));
                    continue;
                }
                turn.push(message);
                continue;
            }
            if (message.role === 'user' && hasAssistant) flush();
            turn.push(message);
            if (message.role === 'assistant') hasAssistant = true;
        }
        flush();

        const unitByMessageId = new Map<string, ContextAtomicUnit>();
        const rebuildUnitIndex = () => {
            unitByMessageId.clear();
            for (const unit of units) {
                for (const messageId of unit.messageIds) unitByMessageId.set(messageId, unit);
            }
        };
        rebuildUnitIndex();
        const trailingRefs: ContextAtomicStateRef[] = [];
        const missingAnchorRefs: ContextAtomicStateRef[] = [];
        const orderedStateRefs = [...(input.stateRefs || [])].sort((left, right) => (
            `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`)
        ));
        for (const ref of orderedStateRefs) {
            const requestedMessageIds = ref.messageIds || [];
            const resolvedUnits = requestedMessageIds.map((id) => unitByMessageId.get(id));
            if (requestedMessageIds.length && resolvedUnits.some((unit) => !unit)) {
                missingAnchorRefs.push(ref);
                continue;
            }
            let targetUnits = [...new Set(resolvedUnits.filter(Boolean))] as ContextAtomicUnit[];
            if (targetUnits.length > 1) {
                const targetIndexes = targetUnits.map((unit) => units.indexOf(unit));
                const firstIndex = Math.min(...targetIndexes);
                const lastIndex = Math.max(...targetIndexes);
                const spannedUnits = units.slice(firstIndex, lastIndex + 1);
                const spannedMessages = spannedUnits
                    .flatMap((unit) => unit.messageIds)
                    .map((messageId) => messages.find((message) => message.messageId === messageId))
                    .filter((message): message is SummaryMessageSource => Boolean(message));
                const invalid = spannedUnits.find((unit) => unit.status === 'invalid');
                const open = spannedUnits.find((unit) => unit.status === 'open');
                const mergedUnit: ContextAtomicUnit = {
                    unitId: unitId(spannedMessages, ':structured'),
                    kind: 'structured_interaction',
                    sequenceStart: spannedUnits[0].sequenceStart,
                    sequenceEnd: spannedUnits[spannedUnits.length - 1].sequenceEnd,
                    messageIds: spannedUnits.flatMap((unit) => unit.messageIds),
                    stateRefs: spannedUnits.flatMap((unit) => unit.stateRefs),
                    status: invalid ? 'invalid' : open ? 'open' : 'closed',
                    ...((invalid?.reason || open?.reason) ? { reason: invalid?.reason || open?.reason } : {}),
                };
                units.splice(firstIndex, lastIndex - firstIndex + 1, mergedUnit);
                rebuildUnitIndex();
                targetUnits = [mergedUnit];
            }
            const target = targetUnits[0];
            if (target) {
                target.stateRefs.push(ref);
                if (ref.status === 'open') {
                    target.status = 'open';
                    target.reason = `Structured state ${ref.kind}:${ref.id} is still open.`;
                }
            } else {
                trailingRefs.push(ref);
            }
        }
        for (const unit of units) {
            unit.stateRefs.sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
        }
        if (missingAnchorRefs.length) {
            units.unshift({
                unitId: `unit:missing-anchor:${missingAnchorRefs.map((ref) => `${ref.kind}:${ref.id}`).join('|')}`,
                kind: 'structured_interaction',
                sequenceStart: 0,
                sequenceEnd: 0,
                messageIds: [],
                stateRefs: missingAnchorRefs,
                status: 'invalid',
                reason: 'A structured interaction references a missing message anchor.',
            });
        }
        if (trailingRefs.length) {
            const unanchoredOpen = trailingRefs.filter((ref) => ref.status === 'open');
            if (unanchoredOpen.length) {
                units.unshift({
                    unitId: `unit:unanchored:${unanchoredOpen.map((ref) => `${ref.kind}:${ref.id}`).join('|')}`,
                    kind: 'structured_interaction',
                    sequenceStart: 0,
                    sequenceEnd: 0,
                    messageIds: [],
                    stateRefs: unanchoredOpen,
                    status: 'invalid',
                    reason: 'An open structured interaction has no stable message anchor.',
                });
            }
            const closedRefs = trailingRefs.filter((ref) => ref.status === 'closed');
            if (closedRefs.length) {
                const sequence = (messages[messages.length - 1]?.sequence || 0) + 1;
                units.push({
                    unitId: `unit:state:${closedRefs.map((ref) => `${ref.kind}:${ref.id}`).join('|')}`,
                    kind: 'structured_interaction',
                    sequenceStart: sequence,
                    sequenceEnd: sequence,
                    messageIds: [],
                    stateRefs: closedRefs,
                    status: 'closed',
                });
            }
        }

        const validBoundaryUnitIds: string[] = [];
        let blockingUnit: ContextAtomicUnit | undefined;
        for (const unit of units) {
            if (unit.status !== 'closed') {
                blockingUnit = unit;
                break;
            }
            if (unit.messageIds.length) validBoundaryUnitIds.push(unit.unitId);
        }
        return { units, validBoundaryUnitIds, ...(blockingUnit ? { blockingUnit } : {}) };
    }

    selectPrefix(input: {
        build: ContextAtomicBuildResult;
        messages: SummaryMessageSource[];
        previousCoverageEndMessageId?: string;
        minimumRecentUnits: number;
        minimumRecentTokens: number;
        countMessageTokens: (messages: SummaryMessageSource[]) => number;
    }): ContextPrefixSelection {
        const messages = [...input.messages].sort((left, right) => left.sequence - right.sequence);
        if (input.build.blockingUnit?.sequenceStart === 0) {
            return {
                coveredMessages: [],
                newlyCoveredMessages: [],
                recentTailMessages: messages,
                blockedBy: input.build.blockingUnit,
            };
        }
        const messageById = new Map(messages.map((message) => [message.messageId, message]));
        const messageUnits = input.build.units.filter((unit) => unit.messageIds.length > 0);
        let tailStart = messageUnits.length;
        let tailTokens = 0;
        let tailUnits = 0;
        while (tailStart > 0 && (tailUnits < input.minimumRecentUnits || tailTokens < input.minimumRecentTokens)) {
            tailStart -= 1;
            const unitMessages = messageUnits[tailStart].messageIds.map((id) => messageById.get(id)).filter(Boolean) as SummaryMessageSource[];
            tailTokens += input.countMessageTokens(unitMessages);
            tailUnits += 1;
        }

        const candidateUnits: ContextAtomicUnit[] = [];
        let blockedBy: ContextAtomicUnit | undefined;
        for (let index = 0; index < tailStart; index += 1) {
            const unit = messageUnits[index];
            if (unit.status !== 'closed') {
                blockedBy = unit;
                break;
            }
            candidateUnits.push(unit);
        }
        const coveredIds = candidateUnits.flatMap((unit) => unit.messageIds);
        const coveredMessages = coveredIds.map((id) => messageById.get(id)).filter(Boolean) as SummaryMessageSource[];
        let previousIndex = -1;
        if (input.previousCoverageEndMessageId) {
            previousIndex = coveredMessages.findIndex((message) => message.messageId === input.previousCoverageEndMessageId);
            if (previousIndex < 0) {
                return {
                    coveredMessages: [],
                    newlyCoveredMessages: [],
                    recentTailMessages: messages,
                    blockedBy: {
                        unitId: 'unit:invalid:previous-coverage',
                        kind: 'structured_interaction',
                        sequenceStart: 0,
                        sequenceEnd: 0,
                        messageIds: [],
                        stateRefs: [],
                        status: 'invalid',
                        reason: 'Previous coverage boundary is not present in the selected closed prefix.',
                    },
                };
            }
        }
        const newlyCoveredMessages = coveredMessages.slice(previousIndex + 1);
        const coveredSet = new Set(coveredMessages.map((message) => message.messageId));
        return {
            coveredMessages,
            newlyCoveredMessages,
            boundaryUnitId: candidateUnits[candidateUnits.length - 1]?.unitId,
            recentTailMessages: messages.filter((message) => !coveredSet.has(message.messageId)),
            ...(blockedBy ? { blockedBy } : {}),
        };
    }
}
