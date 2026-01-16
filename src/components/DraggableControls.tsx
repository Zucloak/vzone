import React, { useState, useEffect, useRef } from 'react';
import { Pause, Play, Square, Settings, GripHorizontal } from 'lucide-react';

interface DraggableControlsProps {
    isPaused: boolean;
    onPauseResume: () => void;
    onStop: () => void;
    timer: number;
}

export const DraggableControls: React.FC<DraggableControlsProps> = ({
    isPaused,
    onPauseResume,
    onStop,
    timer
}) => {
    const [position, setPosition] = useState({ x: 20, y: 20 });
    const [isDragging, setIsDragging] = useState(false);
    const [offset, setOffset] = useState({ x: 0, y: 0 });
    const panelRef = useRef<HTMLDivElement>(null);

    const formatTime = (seconds: number) => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    };

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!isDragging) return;
            setPosition({
                x: e.clientX - offset.x,
                y: e.clientY - offset.y,
            });
        };

        const handleMouseUp = () => {
            setIsDragging(false);
        };

        if (isDragging) {
            window.addEventListener('mousemove', handleMouseMove);
            window.addEventListener('mouseup', handleMouseUp);
        }

        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isDragging, offset]);

    const handleMouseDown = (e: React.MouseEvent) => {
        if (panelRef.current) {
            const rect = panelRef.current.getBoundingClientRect();
            setOffset({
                x: e.clientX - rect.left,
                y: e.clientY - rect.top,
            });
            setIsDragging(true);
        }
    };

    return (
        <div
            ref={panelRef}
            style={{
                left: `${position.x}px`,
                top: `${position.y}px`,
                position: 'fixed',
                zIndex: 9999,
            }}
            className="bg-white/90 backdrop-blur-md shadow-2xl rounded-2xl p-2 border border-white/20 flex flex-col items-center gap-4 w-16 transition-transform duration-75 ease-out select-none"
        >
            <div
                onMouseDown={handleMouseDown}
                className="w-full flex justify-center cursor-grab active:cursor-grabbing py-1 text-neutral-400 hover:text-neutral-600"
            >
                <GripHorizontal size={16} />
            </div>

            <div className="font-mono text-xs font-semibold text-neutral-600 mb-1">
                {formatTime(timer)}
            </div>

            <button
                onClick={onPauseResume}
                disabled={true} // Pause not implemented in Rust core yet
                title="Pause not supported in this version"
                className="p-3 rounded-full bg-neutral-100 text-neutral-400 cursor-not-allowed transition-colors shadow-inner opacity-50"
            >
                {isPaused ? <Play size={20} fill="currentColor" /> : <Pause size={20} fill="currentColor" />}
            </button>

            <button
                onClick={onStop}
                className="p-3 rounded-full bg-red-500 text-white hover:bg-red-600 transition-colors shadow-md"
            >
                <Square size={20} fill="currentColor" />
            </button>

            <div className="h-px w-8 bg-neutral-200 my-1"></div>

            <button className="p-2 text-neutral-400 hover:text-neutral-800 transition-colors">
                <Settings size={16} />
            </button>
        </div>
    );
};
