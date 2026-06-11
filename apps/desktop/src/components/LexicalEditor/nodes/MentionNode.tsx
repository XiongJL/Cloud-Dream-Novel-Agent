/**
 * MentionNode - 自定义 Lexical DecoratorNode
 * 用于在编辑器中渲染角色/物品的行内胶囊标签
 */
import {
    DecoratorNode,
    DOMExportOutput,
    LexicalNode,
    NodeKey,
    SerializedLexicalNode,
    Spread,
} from 'lexical';
import { ReactNode } from 'react';
import i18next from 'i18next';

export type MentionType = 'character' | 'item' | 'world' | 'map';

export type SerializedMentionNode = Spread<
    {
        mentionId: string;
        mentionName: string;
        mentionType: MentionType;
    },
    SerializedLexicalNode
>;

export class MentionNode extends DecoratorNode<ReactNode> {
    __mentionId: string;
    __mentionName: string;
    __mentionType: MentionType;

    static getType(): string {
        return 'mention';
    }

    static clone(node: MentionNode): MentionNode {
        return new MentionNode(
            node.__mentionId,
            node.__mentionName,
            node.__mentionType,
            node.__key
        );
    }

    constructor(
        mentionId: string,
        mentionName: string,
        mentionType: MentionType,
        key?: NodeKey
    ) {
        super(key);
        this.__mentionId = mentionId;
        this.__mentionName = mentionName;
        this.__mentionType = mentionType;
    }

    createDOM(): HTMLElement {
        const span = document.createElement('span');
        span.className = `mention-capsule mention-${this.__mentionType}`;
        span.dataset.mentionId = this.__mentionId;
        span.dataset.mentionType = this.__mentionType;
        return span;
    }

    updateDOM(): boolean {
        return false;
    }

    exportDOM(): DOMExportOutput {
        const element = document.createElement('span');
        element.className = `mention-capsule mention-${this.__mentionType}`;
        element.dataset.mentionId = this.__mentionId;
        element.dataset.mentionType = this.__mentionType;
        element.textContent = `@${this.__mentionName}`;
        return { element };
    }

    static importJSON(serializedNode: SerializedMentionNode): MentionNode {
        return $createMentionNode(
            serializedNode.mentionId,
            serializedNode.mentionName,
            serializedNode.mentionType
        );
    }

    exportJSON(): SerializedMentionNode {
        return {
            type: 'mention',
            version: 1,
            mentionId: this.__mentionId,
            mentionName: this.__mentionName,
            mentionType: this.__mentionType,
        };
    }

    getTextContent(): string {
        return `@${this.__mentionName}`;
    }

    getMentionId(): string {
        return this.__mentionId;
    }

    getMentionName(): string {
        return this.__mentionName;
    }

    getMentionType(): MentionType {
        return this.__mentionType;
    }

    isInline(): boolean {
        return true;
    }

    decorate(): ReactNode {
        const iconMap: Record<MentionType, string> = {
            character: '👤',
            item: '📦',
            world: '🌐',
            map: '🗺️',
        };
        const labelMap: Record<MentionType, string> = {
            character: i18next.t('world.characters'),
            item: i18next.t('world.items'),
            world: i18next.t('world.worldview'),
            map: i18next.t('map.title'),
        };
        return (
            <span
                className={`mention-capsule-inner mention-${this.__mentionType}`}
                title={`${labelMap[this.__mentionType]}: ${this.__mentionName}`}
            >
                <span className="mention-icon">{iconMap[this.__mentionType]}</span>
                <span className="mention-text">{this.__mentionName}</span>
            </span>
        );
    }
}

export function $createMentionNode(
    mentionId: string,
    mentionName: string,
    mentionType: MentionType
): MentionNode {
    return new MentionNode(mentionId, mentionName, mentionType);
}

export function $isMentionNode(node: LexicalNode | null | undefined): node is MentionNode {
    return node instanceof MentionNode;
}
