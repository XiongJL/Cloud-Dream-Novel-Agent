import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';
import { Ellipsis, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';

type Props = {
  isDark: boolean;
  disabled: boolean;
  discardLabel: string;
  onDiscard: () => void;
};

export function DraftMoreMenu({ isDark, disabled, discardLabel, onDiscard }: Props) {
  return (
    <Menu as="div" className="relative">
      <MenuButton
        disabled={disabled}
        title="更多操作"
        aria-label="更多草稿操作"
        className={clsx('grid h-9 w-9 place-items-center rounded-md border disabled:opacity-45', isDark ? 'border-white/10 text-neutral-300' : 'border-[var(--ui-border-strong)] bg-white text-[var(--ui-text-secondary)]')}
      >
        <Ellipsis className="h-4 w-4" />
      </MenuButton>
      <MenuItems className={clsx('absolute bottom-11 right-0 z-30 w-40 rounded-md border p-1 shadow-lg outline-none', isDark ? 'border-white/10 bg-[#1a1a20]' : 'border-[var(--ui-border)] bg-white')}>
        <MenuItem>
          <button
            type="button"
            onClick={onDiscard}
            className={clsx('flex h-9 w-full items-center gap-2 rounded px-2.5 text-left text-sm data-[focus]:bg-red-500/10', isDark ? 'text-red-300' : 'text-[#a43d35]')}
          >
            <Trash2 className="h-4 w-4" />
            {discardLabel}
          </button>
        </MenuItem>
      </MenuItems>
    </Menu>
  );
}
