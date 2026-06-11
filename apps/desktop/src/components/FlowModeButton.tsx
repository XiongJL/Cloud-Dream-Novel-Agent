import React from 'react';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';

interface FlowModeButtonProps {
    isActive: boolean;
    onClick: () => void;
    className?: string;
}

export const FlowModeButton: React.FC<FlowModeButtonProps> = ({ isActive, onClick, className }) => {
    const { t } = useTranslation();

    return (
        <button
            onClick={onClick}
            className={clsx(
                "flow-btn-container group",
                isActive && "scale-110",
                className
            )}
            title={t('editor.flowMode', 'Flow Mode')}
        >
            <div className="flow-btn-bg" />
            <div className="flow-btn-content">
                {isActive ? t('editor.inFlow', 'Entering Flow') : t('editor.flowMode')}
            </div>
        </button>
    );
};
