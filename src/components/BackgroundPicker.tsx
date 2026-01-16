import React from 'react';
import type { BackgroundConfig } from '../types';

interface BackgroundPickerProps {
    config: BackgroundConfig;
    onChange: (config: BackgroundConfig) => void;
}

export const BackgroundPicker: React.FC<BackgroundPickerProps> = ({ config, onChange }) => {
    const solids = ['#171717', '#ffffff', '#e5e5e5', '#3b82f6', '#ef4444'];
    const gradients = [
        { start: '#fbc2eb', end: '#a6c1ee' },
        { start: '#84fab0', end: '#8fd3f4' },
        { start: '#e0c3fc', end: '#8ec5fc' },
    ];

    return (
        <div className="flex flex-col gap-4">
            <div>
                <label className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2 block">Solid Colors</label>
                <div className="flex gap-2">
                    {solids.map(color => (
                        <button
                            key={color}
                            onClick={() => onChange({ type: 'solid', color })}
                            className={`w-8 h-8 rounded-full border border-neutral-200 shadow-sm transition-transform hover:scale-110 ${config.type === 'solid' && config.color === color ? 'ring-2 ring-neutral-900 ring-offset-2' : ''}`}
                            style={{ backgroundColor: color }}
                        />
                    ))}
                </div>
            </div>

            <div>
                <label className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2 block">Gradients</label>
                <div className="flex gap-2">
                    {gradients.map((g, i) => (
                        <button
                            key={i}
                            onClick={() => onChange({ type: 'gradient', color: '', startColor: g.start, endColor: g.end, direction: 'to right' })}
                            className={`w-8 h-8 rounded-full border border-neutral-200 shadow-sm transition-transform hover:scale-110 ${config.type === 'gradient' && config.startColor === g.start ? 'ring-2 ring-neutral-900 ring-offset-2' : ''}`}
                            style={{ background: `linear-gradient(to right, ${g.start}, ${g.end})` }}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
};
