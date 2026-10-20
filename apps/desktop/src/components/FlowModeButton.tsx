import React from 'react';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import { Feather } from 'lucide-react';

interface FlowModeButtonProps {
    isActive: boolean;
    onClick: () => void;
    className?: string;
}

export const FlowModeButton: React.FC<FlowModeButtonProps> = ({ isActive, onClick, className }) => {
    const { t } = useTranslation();

    return (
        <button
            type="button"
            onClick={onClick}
            className={clsx(
                "flow-btn-container",
                isActive && "is-active",
                className
            )}
            title={isActive ? t('common.exitFlow') : t('editor.flowMode')}
            aria-pressed={isActive}
        >
            <span className="flow-btn-content">
                <Feather size={13} aria-hidden="true" />
                {isActive ? t('editor.inFlow', 'Immersive Writing') : t('editor.flowMode')}
            </span>
        </button>
    );
};
