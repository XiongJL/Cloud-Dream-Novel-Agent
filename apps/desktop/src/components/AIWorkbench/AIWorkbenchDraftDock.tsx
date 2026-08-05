import { clsx } from 'clsx';
import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AssetDraftList } from './AssetDraftList';
import type { CreativeAssetsDraft, DraftSelection } from './types';

type Props = {
  theme: 'dark' | 'light';
  draft: CreativeAssetsDraft;
  selection: DraftSelection;
  onDraftChange: (next: CreativeAssetsDraft) => void;
  onSelectionChange: (next: DraftSelection) => void;
  onDraftAndSelectionChange?: (nextDraft: CreativeAssetsDraft, nextSelection: DraftSelection) => void;
};

export default function AIWorkbenchDraftDock({
  theme,
  draft,
  selection,
  onDraftChange,
  onSelectionChange,
  onDraftAndSelectionChange,
}: Props) {
  const { t } = useTranslation();
  const isDark = theme === 'dark';

  const updateSelectionAt = (category: keyof DraftSelection, index: number, checked: boolean) => {
    const next = { ...selection, [category]: [...selection[category]] };
    next[category][index] = checked;
    onSelectionChange(next);
  };

  const removeAt = (category: keyof DraftSelection, index: number) => {
    const nextDraft = { ...draft } as CreativeAssetsDraft;
    const list = [...((nextDraft as any)[category] ?? [])];
    list.splice(index, 1);
    (nextDraft as any)[category] = list;

    const nextSelection = { ...selection, [category]: [...selection[category]] };
    nextSelection[category].splice(index, 1);

    if (onDraftAndSelectionChange) {
      onDraftAndSelectionChange(nextDraft, nextSelection);
      return;
    }

    onDraftChange(nextDraft);
    onSelectionChange(nextSelection);
  };

  return (
    <div className={clsx('h-full min-h-0 flex flex-col', isDark ? 'bg-[#0F0F13]' : 'bg-gray-50')}>
      <div className={clsx('px-3 py-3 border-b', isDark ? 'border-white/10' : 'border-gray-200')}>
        <h3 className={clsx('text-sm font-semibold', isDark ? 'text-neutral-100' : 'text-gray-900')}>
          {t('aiWorkbench.dockTitle')}
        </h3>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        <AssetDraftList title={t('aiWorkbench.sectionPlotLines')} count={draft.plotLines?.length ?? 0} theme={theme} emptyText={t('aiWorkbench.emptyDraft')}>
          {(draft.plotLines ?? []).map((line, index) => (
            <div key={`plot-line-${index}`} className={clsx('rounded-lg border p-2 space-y-1.5', isDark ? 'border-white/10' : 'border-gray-200')}>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={selection.plotLines[index] || false} onChange={(event) => updateSelectionAt('plotLines', index, event.target.checked)} />
                <input
                  value={line.name || ''}
                  onChange={(event) => {
                    const next = { ...draft, plotLines: [...(draft.plotLines ?? [])] };
                    next.plotLines![index] = { ...next.plotLines![index], name: event.target.value };
                    onDraftChange(next);
                  }}
                  placeholder={t('aiWorkbench.placeholderPlotLineName')}
                  className={clsx('flex-1 rounded border px-2 py-1 text-xs', isDark ? 'bg-black/20 border-white/10 text-neutral-200' : 'bg-white border-gray-200 text-gray-700')}
                />
                <button onClick={() => removeAt('plotLines', index)} className={clsx('p-1 rounded border', isDark ? 'border-white/10 text-neutral-300' : 'border-gray-200 text-gray-600')}>
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              <textarea
                value={line.description || ''}
                onChange={(event) => {
                  const next = { ...draft, plotLines: [...(draft.plotLines ?? [])] };
                  next.plotLines![index] = { ...next.plotLines![index], description: event.target.value };
                  onDraftChange(next);
                }}
                rows={2}
                placeholder={t('aiWorkbench.placeholderPlotLineDescription')}
                className={clsx('w-full rounded border px-2 py-1 text-xs resize-y', isDark ? 'bg-black/20 border-white/10 text-neutral-200' : 'bg-white border-gray-200 text-gray-700')}
              />
            </div>
          ))}
        </AssetDraftList>

        <AssetDraftList title={t('aiWorkbench.sectionPlotPoints')} count={draft.plotPoints?.length ?? 0} theme={theme} emptyText={t('aiWorkbench.emptyDraft')}>
          {(draft.plotPoints ?? []).map((point, index) => (
            <div key={`plot-point-${index}`} className={clsx('rounded-lg border p-2 space-y-1.5', isDark ? 'border-white/10' : 'border-gray-200')}>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={selection.plotPoints[index] || false} onChange={(event) => updateSelectionAt('plotPoints', index, event.target.checked)} />
                <input
                  value={point.title || ''}
                  onChange={(event) => {
                    const next = { ...draft, plotPoints: [...(draft.plotPoints ?? [])] };
                    next.plotPoints![index] = { ...next.plotPoints![index], title: event.target.value };
                    onDraftChange(next);
                  }}
                  placeholder={t('aiWorkbench.placeholderPlotPointTitle')}
                  className={clsx('flex-1 rounded border px-2 py-1 text-xs', isDark ? 'bg-black/20 border-white/10 text-neutral-200' : 'bg-white border-gray-200 text-gray-700')}
                />
                <button onClick={() => removeAt('plotPoints', index)} className={clsx('p-1 rounded border', isDark ? 'border-white/10 text-neutral-300' : 'border-gray-200 text-gray-600')}>
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              <input
                value={point.plotLineName || ''}
                onChange={(event) => {
                  const next = { ...draft, plotPoints: [...(draft.plotPoints ?? [])] };
                  next.plotPoints![index] = { ...next.plotPoints![index], plotLineName: event.target.value };
                  onDraftChange(next);
                }}
                placeholder={t('aiWorkbench.placeholderPlotPointLine')}
                className={clsx('w-full rounded border px-2 py-1 text-xs', isDark ? 'bg-black/20 border-white/10 text-neutral-200' : 'bg-white border-gray-200 text-gray-700')}
              />
              <textarea
                value={point.description || ''}
                onChange={(event) => {
                  const next = { ...draft, plotPoints: [...(draft.plotPoints ?? [])] };
                  next.plotPoints![index] = { ...next.plotPoints![index], description: event.target.value };
                  onDraftChange(next);
                }}
                rows={2}
                placeholder={t('aiWorkbench.placeholderPlotPointDescription')}
                className={clsx('w-full rounded border px-2 py-1 text-xs resize-y', isDark ? 'bg-black/20 border-white/10 text-neutral-200' : 'bg-white border-gray-200 text-gray-700')}
              />
            </div>
          ))}
        </AssetDraftList>

        <AssetDraftList title={t('aiWorkbench.sectionCharacters')} count={draft.characters?.length ?? 0} theme={theme} emptyText={t('aiWorkbench.emptyDraft')}>
          {(draft.characters ?? []).map((character, index) => (
            <div key={`character-${index}`} className={clsx('rounded-lg border p-2 space-y-1.5', isDark ? 'border-white/10' : 'border-gray-200')}>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={selection.characters[index] || false} onChange={(event) => updateSelectionAt('characters', index, event.target.checked)} />
                <input
                  value={character.name || ''}
                  onChange={(event) => {
                    const next = { ...draft, characters: [...(draft.characters ?? [])] };
                    next.characters![index] = { ...next.characters![index], name: event.target.value };
                    onDraftChange(next);
                  }}
                  placeholder={t('aiWorkbench.placeholderCharacterName')}
                  className={clsx('flex-1 rounded border px-2 py-1 text-xs', isDark ? 'bg-black/20 border-white/10 text-neutral-200' : 'bg-white border-gray-200 text-gray-700')}
                />
                <button onClick={() => removeAt('characters', index)} className={clsx('p-1 rounded border', isDark ? 'border-white/10 text-neutral-300' : 'border-gray-200 text-gray-600')}>
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              <input
                value={character.role || ''}
                onChange={(event) => {
                  const next = { ...draft, characters: [...(draft.characters ?? [])] };
                  next.characters![index] = { ...next.characters![index], role: event.target.value };
                  onDraftChange(next);
                }}
                placeholder={t('aiWorkbench.placeholderCharacterRole')}
                className={clsx('w-full rounded border px-2 py-1 text-xs', isDark ? 'bg-black/20 border-white/10 text-neutral-200' : 'bg-white border-gray-200 text-gray-700')}
              />
              <textarea
                value={character.description || ''}
                onChange={(event) => {
                  const next = { ...draft, characters: [...(draft.characters ?? [])] };
                  next.characters![index] = { ...next.characters![index], description: event.target.value };
                  onDraftChange(next);
                }}
                rows={2}
                placeholder={t('aiWorkbench.placeholderCharacterDescription')}
                className={clsx('w-full rounded border px-2 py-1 text-xs resize-y', isDark ? 'bg-black/20 border-white/10 text-neutral-200' : 'bg-white border-gray-200 text-gray-700')}
              />
            </div>
          ))}
        </AssetDraftList>

        <AssetDraftList title={t('aiWorkbench.sectionItems')} count={draft.items?.length ?? 0} theme={theme} emptyText={t('aiWorkbench.emptyDraft')}>
          {(draft.items ?? []).map((item, index) => (
            <div key={`item-${index}`} className={clsx('rounded-lg border p-2 space-y-1.5', isDark ? 'border-white/10' : 'border-gray-200')}>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={selection.items[index] || false} onChange={(event) => updateSelectionAt('items', index, event.target.checked)} />
                <input
                  value={item.name || ''}
                  onChange={(event) => {
                    const next = { ...draft, items: [...(draft.items ?? [])] };
                    next.items![index] = { ...next.items![index], name: event.target.value };
                    onDraftChange(next);
                  }}
                  placeholder={t('aiWorkbench.placeholderItemName')}
                  className={clsx('flex-1 rounded border px-2 py-1 text-xs', isDark ? 'bg-black/20 border-white/10 text-neutral-200' : 'bg-white border-gray-200 text-gray-700')}
                />
                <button onClick={() => removeAt('items', index)} className={clsx('p-1 rounded border', isDark ? 'border-white/10 text-neutral-300' : 'border-gray-200 text-gray-600')}>
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              <select
                value={item.type || 'item'}
                onChange={(event) => {
                  const next = { ...draft, items: [...(draft.items ?? [])] };
                  next.items![index] = { ...next.items![index], type: event.target.value };
                  onDraftChange(next);
                }}
                className={clsx('w-full rounded border px-2 py-1 text-xs', isDark ? 'bg-black/20 border-white/10 text-neutral-200' : 'bg-white border-gray-200 text-gray-700')}
              >
                <option value="item">{t('aiWorkbench.itemTypeItem')}</option>
                <option value="skill">{t('aiWorkbench.itemTypeSkill')}</option>
                <option value="location">{t('aiWorkbench.itemTypeLocation')}</option>
              </select>
              <textarea
                value={item.description || ''}
                onChange={(event) => {
                  const next = { ...draft, items: [...(draft.items ?? [])] };
                  next.items![index] = { ...next.items![index], description: event.target.value };
                  onDraftChange(next);
                }}
                rows={2}
                placeholder={t('aiWorkbench.placeholderItemDescription')}
                className={clsx('w-full rounded border px-2 py-1 text-xs resize-y', isDark ? 'bg-black/20 border-white/10 text-neutral-200' : 'bg-white border-gray-200 text-gray-700')}
              />
            </div>
          ))}
        </AssetDraftList>

        <AssetDraftList title={t('aiWorkbench.sectionSkills')} count={draft.skills?.length ?? 0} theme={theme} emptyText={t('aiWorkbench.emptyDraft')}>
          {(draft.skills ?? []).map((skill, index) => (
            <div key={`skill-${index}`} className={clsx('rounded-lg border p-2 space-y-1.5', isDark ? 'border-white/10' : 'border-gray-200')}>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={selection.skills[index] || false} onChange={(event) => updateSelectionAt('skills', index, event.target.checked)} />
                <input
                  value={skill.name || ''}
                  onChange={(event) => {
                    const next = { ...draft, skills: [...(draft.skills ?? [])] };
                    next.skills![index] = { ...next.skills![index], name: event.target.value };
                    onDraftChange(next);
                  }}
                  placeholder={t('aiWorkbench.placeholderSkillName')}
                  className={clsx('flex-1 rounded border px-2 py-1 text-xs', isDark ? 'bg-black/20 border-white/10 text-neutral-200' : 'bg-white border-gray-200 text-gray-700')}
                />
                <button onClick={() => removeAt('skills', index)} className={clsx('p-1 rounded border', isDark ? 'border-white/10 text-neutral-300' : 'border-gray-200 text-gray-600')}>
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              <textarea
                value={skill.description || ''}
                onChange={(event) => {
                  const next = { ...draft, skills: [...(draft.skills ?? [])] };
                  next.skills![index] = { ...next.skills![index], description: event.target.value };
                  onDraftChange(next);
                }}
                rows={2}
                placeholder={t('aiWorkbench.placeholderSkillDescription')}
                className={clsx('w-full rounded border px-2 py-1 text-xs resize-y', isDark ? 'bg-black/20 border-white/10 text-neutral-200' : 'bg-white border-gray-200 text-gray-700')}
              />
            </div>
          ))}
        </AssetDraftList>

        <AssetDraftList title={t('aiWorkbench.sectionWorldSettings')} count={draft.worldSettings?.length ?? 0} theme={theme} emptyText={t('aiWorkbench.emptyDraft')}>
          {(draft.worldSettings ?? []).map((setting, index) => (
            <div key={`world-setting-${index}`} className={clsx('rounded-lg border p-2 space-y-1.5', isDark ? 'border-white/10' : 'border-gray-200')}>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={selection.worldSettings[index] || false} onChange={(event) => updateSelectionAt('worldSettings', index, event.target.checked)} />
                <input
                  value={setting.name || ''}
                  onChange={(event) => {
                    const next = { ...draft, worldSettings: [...(draft.worldSettings ?? [])] };
                    next.worldSettings![index] = { ...next.worldSettings![index], name: event.target.value };
                    onDraftChange(next);
                  }}
                  placeholder={t('aiWorkbench.placeholderWorldSettingName')}
                  className={clsx('flex-1 rounded border px-2 py-1 text-xs', isDark ? 'bg-black/20 border-white/10 text-neutral-200' : 'bg-white border-gray-200 text-gray-700')}
                />
                <button onClick={() => removeAt('worldSettings', index)} className={clsx('p-1 rounded border', isDark ? 'border-white/10 text-neutral-300' : 'border-gray-200 text-gray-600')}>
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              <select
                value={setting.type || 'other'}
                onChange={(event) => {
                  const next = { ...draft, worldSettings: [...(draft.worldSettings ?? [])] };
                  next.worldSettings![index] = {
                    ...next.worldSettings![index],
                    type: event.target.value as 'history' | 'geography' | 'magic_system' | 'faction' | 'technology' | 'other',
                  };
                  onDraftChange(next);
                }}
                className={clsx('w-full rounded border px-2 py-1 text-xs', isDark ? 'bg-black/20 border-white/10 text-neutral-200' : 'bg-white border-gray-200 text-gray-700')}
              >
                <option value="history">{t('aiWorkbench.worldSettingTypeHistory')}</option>
                <option value="geography">{t('aiWorkbench.worldSettingTypeGeography')}</option>
                <option value="magic_system">{t('aiWorkbench.worldSettingTypeMagicSystem')}</option>
                <option value="faction">{t('aiWorkbench.worldSettingTypeFaction')}</option>
                <option value="technology">{t('aiWorkbench.worldSettingTypeTechnology')}</option>
                <option value="other">{t('aiWorkbench.worldSettingTypeOther')}</option>
              </select>
              <textarea
                value={setting.content || ''}
                onChange={(event) => {
                  const next = { ...draft, worldSettings: [...(draft.worldSettings ?? [])] };
                  next.worldSettings![index] = { ...next.worldSettings![index], content: event.target.value };
                  onDraftChange(next);
                }}
                rows={3}
                placeholder={t('aiWorkbench.placeholderWorldSettingContent')}
                className={clsx('w-full rounded border px-2 py-1 text-xs resize-y', isDark ? 'bg-black/20 border-white/10 text-neutral-200' : 'bg-white border-gray-200 text-gray-700')}
              />
            </div>
          ))}
        </AssetDraftList>

        <AssetDraftList title={t('aiWorkbench.sectionMaps')} count={draft.maps?.length ?? 0} theme={theme} emptyText={t('aiWorkbench.emptyDraft')}>
          {(draft.maps ?? []).map((map, index) => (
            <div key={`map-${index}`} className={clsx('rounded-lg border p-2 space-y-1.5', isDark ? 'border-white/10' : 'border-gray-200')}>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={selection.maps[index] || false} onChange={(event) => updateSelectionAt('maps', index, event.target.checked)} />
                <input
                  value={map.name || ''}
                  onChange={(event) => {
                    const next = { ...draft, maps: [...(draft.maps ?? [])] };
                    next.maps![index] = { ...next.maps![index], name: event.target.value };
                    onDraftChange(next);
                  }}
                  placeholder={t('aiWorkbench.placeholderMapName')}
                  className={clsx('flex-1 rounded border px-2 py-1 text-xs', isDark ? 'bg-black/20 border-white/10 text-neutral-200' : 'bg-white border-gray-200 text-gray-700')}
                />
                <button onClick={() => removeAt('maps', index)} className={clsx('p-1 rounded border', isDark ? 'border-white/10 text-neutral-300' : 'border-gray-200 text-gray-600')}>
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              <select
                value={map.type || 'world'}
                onChange={(event) => {
                  const next = { ...draft, maps: [...(draft.maps ?? [])] };
                  next.maps![index] = { ...next.maps![index], type: event.target.value as 'world' | 'region' | 'scene' };
                  onDraftChange(next);
                }}
                className={clsx('w-full rounded border px-2 py-1 text-xs', isDark ? 'bg-black/20 border-white/10 text-neutral-200' : 'bg-white border-gray-200 text-gray-700')}
              >
                <option value="world">{t('aiWorkbench.mapTypeWorld')}</option>
                <option value="region">{t('aiWorkbench.mapTypeRegion')}</option>
                <option value="scene">{t('aiWorkbench.mapTypeScene')}</option>
              </select>
              <textarea
                value={map.description || ''}
                onChange={(event) => {
                  const next = { ...draft, maps: [...(draft.maps ?? [])] };
                  next.maps![index] = { ...next.maps![index], description: event.target.value };
                  onDraftChange(next);
                }}
                rows={2}
                placeholder={t('aiWorkbench.placeholderMapDescription')}
                className={clsx('w-full rounded border px-2 py-1 text-xs resize-y', isDark ? 'bg-black/20 border-white/10 text-neutral-200' : 'bg-white border-gray-200 text-gray-700')}
              />
              <input
                value={map.imagePrompt || ''}
                onChange={(event) => {
                  const next = { ...draft, maps: [...(draft.maps ?? [])] };
                  next.maps![index] = { ...next.maps![index], imagePrompt: event.target.value };
                  onDraftChange(next);
                }}
                placeholder={t('aiWorkbench.placeholderMapImagePrompt')}
                className={clsx('w-full rounded border px-2 py-1 text-xs', isDark ? 'bg-black/20 border-white/10 text-neutral-200' : 'bg-white border-gray-200 text-gray-700')}
              />
              <input
                value={map.imageUrl || ''}
                onChange={(event) => {
                  const next = { ...draft, maps: [...(draft.maps ?? [])] };
                  next.maps![index] = { ...next.maps![index], imageUrl: event.target.value };
                  onDraftChange(next);
                }}
                placeholder={t('aiWorkbench.placeholderMapImageUrl')}
                className={clsx('w-full rounded border px-2 py-1 text-xs', isDark ? 'bg-black/20 border-white/10 text-neutral-200' : 'bg-white border-gray-200 text-gray-700')}
              />
            </div>
          ))}
        </AssetDraftList>
      </div>
    </div>
  );
}
