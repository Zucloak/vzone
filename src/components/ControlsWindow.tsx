import { useState, useEffect } from 'react';
import { Pause, Square, Play } from 'lucide-react';
import '../index.css';

export default function ControlsWindow() {
    const [duration, setDuration] = useState(0);
    const [isPaused] = useState(false);

    useEffect(() => {
        const interval = setInterval(() => {
            if (!isPaused) setDuration(d => d + 1);
        }, 1000);
        return () => clearInterval(interval);
    }, [isPaused]);

    const formatTime = (secs: number) => {
        const mm = Math.floor(secs / 60).toString().padStart(2, '0');
        const ss = (secs % 60).toString().padStart(2, '0');
        return `${mm}:${ss}`;
    };

    const handleStop = () => {
        if (window.opener) {
            // Focus the parent window first
            window.opener.focus();
            // Send stop message
            window.opener.postMessage({ type: 'STOP_RECORDING' }, '*');
            // Close popup after short delay to ensure message is received
            setTimeout(() => window.close(), 100);
        } else {
            alert("Parent window lost!");
        }
    };

    return (
        <div className="w-full h-full bg-[#1e1e1e] flex items-center justify-between px-4 border-t border-[#333] select-none text-white">
            <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                <span className="font-mono text-sm tracking-wider text-gray-300">
                    {formatTime(duration)}
                </span>
            </div>

            <div className="flex items-center gap-2">
                <button
                    className="p-2 hover:bg-white/10 rounded-md transition-colors text-white/50 cursor-not-allowed"
                    title="Pause not supported yet"
                >
                    {isPaused ? <Play size={16} /> : <Pause size={16} />}
                </button>
                <button
                    onClick={handleStop}
                    className="flex items-center gap-2 px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-500 rounded-md transition-colors border border-red-500/20"
                >
                    <Square size={16} fill="currentColor" />
                    <span className="text-xs font-semibold">STOP</span>
                </button>
            </div>
        </div>
    );
}
