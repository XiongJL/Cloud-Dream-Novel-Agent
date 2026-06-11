import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useEffect } from 'react';
import {
    createCommand,
    COMMAND_PRIORITY_EDITOR,
    $getRoot,
    $isTextNode,
    TextNode
} from 'lexical';

export const FORMAT_CONTENT_COMMAND = createCommand('FORMAT_CONTENT_COMMAND');

interface AutoFormatPluginProps {
    indentMode: 'enabled' | 'disabled';
    language: string; // 'zh' | 'en' etc.
}

/**
 * 格式化文本内容：
 * 1. 删除每行多余的空格（连续空格变为单个）
 * 2. 修正标点符号（根据语言设置）
 * 3. 句首大写（英文）
 */
function formatTextContent(text: string, language: string): string {
    let result = text;

    // 1. 删除连续空格（保留单个）
    result = result.replace(/  +/g, ' ');

    // 2. 删除行首行尾空格（每行）
    result = result.split('\n').map(line => line.trim()).join('\n');

    // 3. 标点符号修正 - 根据语言设置
    if (language === 'zh') {
        // 中文环境：转换为中文标点
        // 英文逗号 -> 中文逗号（在中文字符附近）
        result = result.replace(/,(?=\s*[\u4e00-\u9fa5])/g, '，');
        result = result.replace(/(?<=[\u4e00-\u9fa5]\s*),/g, '，');

        // 英文句号 -> 中文句号（在中文字符附近）
        result = result.replace(/\.(?=\s*[\u4e00-\u9fa5])/g, '。');
        result = result.replace(/(?<=[\u4e00-\u9fa5])\.(?!\d)/g, '。');

        // 三个英文点 -> 中文省略号
        result = result.replace(/\.{3,}/g, '……');
        result = result.replace(/。{2,}/g, '……');

        // 英文问号 -> 中文问号
        result = result.replace(/\?(?=\s*[\u4e00-\u9fa5])/g, '？');
        result = result.replace(/(?<=[\u4e00-\u9fa5])\?/g, '？');

        // 英文感叹号 -> 中文感叹号
        result = result.replace(/!(?=\s*[\u4e00-\u9fa5])/g, '！');
        result = result.replace(/(?<=[\u4e00-\u9fa5])!/g, '！');

        // 英文冒号 -> 中文冒号
        result = result.replace(/:(?=\s*[\u4e00-\u9fa5])/g, '：');
        result = result.replace(/(?<=[\u4e00-\u9fa5]):/g, '：');

        // 英文分号 -> 中文分号
        result = result.replace(/;(?=\s*[\u4e00-\u9fa5])/g, '；');
        result = result.replace(/(?<=[\u4e00-\u9fa5]);/g, '；');

        // 删除中文标点前后的空格
        result = result.replace(/\s+([，。？！：；、])/g, '$1');
        result = result.replace(/([，。？！：；、])\s+/g, '$1');
    } else {
        // 英文环境：转换为英文标点
        // 中文逗号 -> 英文逗号
        result = result.replace(/，/g, ', ');

        // 中文句号 -> 英文句号
        result = result.replace(/。/g, '. ');

        // 中文省略号 -> 英文省略号
        result = result.replace(/……/g, '...');

        // 中文问号 -> 英文问号
        result = result.replace(/？/g, '? ');

        // 中文感叹号 -> 英文感叹号
        result = result.replace(/！/g, '! ');

        // 中文冒号 -> 英文冒号
        result = result.replace(/：/g, ': ');

        // 中文分号 -> 英文分号
        result = result.replace(/；/g, '; ');

        // 清理多余空格（转换后可能产生）
        result = result.replace(/  +/g, ' ');
    }

    // 4. 删除连续的相同标点
    result = result.replace(/，{2,}/g, '，');
    result = result.replace(/。{2,}/g, '。');
    result = result.replace(/？{2,}/g, '？');
    result = result.replace(/！{2,}/g, '！');
    result = result.replace(/,{2,}/g, ',');
    result = result.replace(/\.{4,}/g, '...');
    result = result.replace(/\?{2,}/g, '?');
    result = result.replace(/!{2,}/g, '!');

    // 5. 句首大写（英文）
    // 匹配句子开头的小写字母（在句号、问号、感叹号、换行后）
    result = result.replace(/(^|[.?!。？！]\s*)([a-z])/gm, (_match, prefix, letter) => {
        return prefix + letter.toUpperCase();
    });

    // 段落开头大写
    result = result.replace(/(\n\s*)([a-z])/g, (_match, prefix, letter) => {
        return prefix + letter.toUpperCase();
    });

    return result;
}

export default function AutoFormatPlugin({ indentMode, language }: AutoFormatPluginProps) {
    const [editor] = useLexicalComposerContext();

    useEffect(() => {
        return editor.registerCommand(
            FORMAT_CONTENT_COMMAND,
            () => {
                editor.update(() => {
                    const root = $getRoot();

                    // 递归处理所有文本节点
                    const processNode = (node: any) => {
                        if ($isTextNode(node)) {
                            const textNode = node as TextNode;
                            const originalText = textNode.getTextContent();
                            const formattedText = formatTextContent(originalText, language);

                            if (originalText !== formattedText) {
                                textNode.setTextContent(formattedText);
                            }
                        }

                        // 处理子节点
                        if ('getChildren' in node && typeof node.getChildren === 'function') {
                            const children = node.getChildren();
                            children.forEach((child: any) => processNode(child));
                        }
                    };

                    processNode(root);
                });

                return true;
            },
            COMMAND_PRIORITY_EDITOR
        );
    }, [editor, indentMode, language]);

    return null;
}
