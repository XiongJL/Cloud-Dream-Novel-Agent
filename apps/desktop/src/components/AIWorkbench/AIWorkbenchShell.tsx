import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { Boxes, MessageSquareText } from 'lucide-react';
import AIWorkbenchPanel from './AIWorkbenchPanel';
import NovelAskPanel from './NovelAskPanel';
import type { CreativeAssetsDraft, DraftSelection, DraftSessionRecord } from './types';

type Props = {
  novelId: string;
  theme: 'dark' | 'light';
  draft: CreativeAssetsDraft;
  selection: DraftSelection;
  draftSession: DraftSessionRecord | null;
  onDraftChange: (next: CreativeAssetsDraft) => void;
  onSelectionChange: (next: DraftSelection) => void;
  onDraftSessionChange: (next: DraftSessionRecord | null) => void;
  onDraftGenerated?: () => void;
  currentChapterId?: string | null;
  currentContent?: string;
};

type WorkbenchMode = 'assets' | 'rag';

export default function AIWorkbenchShell(props: Props) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<WorkbenchMode>('assets');
  const isDark = props.theme === 'dark';

  return (
    <div className={clsx('h-full min-h-0 flex flex-col', isDark ? 'bg-[#0F0F13]' : 'bg-gray-50')}>
      <div className={clsx('shrink-0 border-b px-3 py-2', isDark ? 'border-white/5' : 'border-gray-200')}>
        <div className={clsx('grid grid-cols-2 gap-1 rounded-lg border p-1', isDark ? 'border-white/10 bg-black/20' : 'border-gray-200 bg-white')}>
          <button
            type="button"
            onClick={() => setMode('assets')}
            className={clsx(
              'inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors',
              mode === 'assets'
                ? (isDark ? 'bg-white/10 text-neutral-100' : 'bg-gray-100 text-gray-900')
                : (isDark ? 'text-neutral-400 hover:text-neutral-100' : 'text-gray-500 hover:text-gray-900'),
            )}
          >
            <Boxes className="h-3.5 w-3.5" />
            {t('aiWorkbench.modeAssets')}
          </button>
          <button
            type="button"
            onClick={() => setMode('rag')}
            className={clsx(
              'inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors',
              mode === 'rag'
                ? (isDark ? 'bg-white/10 text-neutral-100' : 'bg-gray-100 text-gray-900')
                : (isDark ? 'text-neutral-400 hover:text-neutral-100' : 'text-gray-500 hover:text-gray-900'),
            )}
          >
            <MessageSquareText className="h-3.5 w-3.5" />
            {t('aiWorkbench.modeRag')}
          </button>
        </div>
      </div>

      <div className={clsx('flex-1 min-h-0', mode !== 'assets' && 'hidden')}>
        <AIWorkbenchPanel {...props} />
      </div>
      <div className={clsx('flex-1 min-h-0', mode !== 'rag' && 'hidden')}>
        <NovelAskPanel
          novelId={props.novelId}
          theme={props.theme}
          currentChapterId={props.currentChapterId}
          currentContent={props.currentContent}
        />
      </div>
    </div>
  );
}
