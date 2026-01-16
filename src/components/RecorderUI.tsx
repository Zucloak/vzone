import React, { useState, useEffect } from 'react';
import { useRecorder } from '../hooks/useRecorder';
import { MonitorPlay, RotateCcw, Download } from 'lucide-react';
import { DraggableControls } from './DraggableControls';
import { BackgroundPicker } from './BackgroundPicker';

export const RecorderUI: React.FC = () => {
    const {
        isRecording,
        isReady,
        startRecording,
        stopRecording,
        canvasRef,
        previewBlobUrl,
        setBackground,
        backgroundConfig
    } = useRecorder();

    // Local state for UI feedback (timers, etc.) that mirrors the hook
    const [timer, setTimer] = useState(0);
    const timerInterval = React.useRef<number | null>(null);

    // Sync background config from hook to local UI usage if needed
    // Actually we just pass setBackground to the picker.

    useEffect(() => {
        if (isRecording) {
            timerInterval.current = window.setInterval(() => {
                setTimer(t => t + 1);
            }, 1000);
        } else {
            if (timerInterval.current) clearInterval(timerInterval.current);
            setTimer(0);
        }
        return () => {
            if (timerInterval.current) clearInterval(timerInterval.current);
        };
    }, [isRecording]);

    const handleReset = () => {
        window.location.reload(); // Simple reset for now to clear blobs/streams
    };

    return (
        <div className="min-h-screen flex flex-col items-center justify-center p-8 relative overflow-hidden bg-apple-gray text-[#111]">
            {/* Header */}
            <header className="absolute top-0 left-0 w-full p-8 flex justify-between items-center z-10">
                <div className="flex items-center gap-2">
                    <div className="w-4 h-4 bg-black rounded-sm"></div>
                    <span className="font-bold text-xl tracking-tight">V.ZONE</span>
                </div>
                <div className="flex gap-4">
                    {previewBlobUrl && (
                        <button onClick={handleReset} className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-neutral-500 hover:text-black transition-colors">
                            <RotateCcw size={14} /> New Project
                        </button>
                    )}
                </div>
            </header>

            {/* Draggable Controls (Only when recording) */}
            {isRecording && (
                <DraggableControls
                    isPaused={false}
                    onPauseResume={() => { }}
                    onStop={stopRecording}
                    timer={timer}
                />
            )}

            <main className="w-full max-w-6xl flex flex-col items-center gap-8 z-0">

                {/* Idle / Hero State */}
                {!isRecording && !previewBlobUrl && (
                    <div className="text-center space-y-6 max-w-lg animated-fade-in">
                        <h1 className="text-5xl font-bold tracking-tighter text-neutral-900 leading-tight">
                            Record. <span className="text-neutral-400">Refine.</span> Release.
                        </h1>
                        <p className="text-lg text-neutral-500 font-light">
                            High-performance recording with physics-based smooth camera. <br />
                            <span className="text-xs mt-2 inline-block opacity-70 bg-yellow-100 text-yellow-800 px-2 py-1 rounded">
                                Native Wasm Core • 60FPS • H.264
                            </span>
                        </p>

                        <div className="bg-white p-6 rounded-2xl shadow-sm border border-neutral-100 mt-8">
                            <h3 className="text-sm font-bold text-neutral-900 mb-4">Choose Background (Baked in)</h3>
                            <BackgroundPicker config={backgroundConfig} onChange={setBackground} />
                        </div>

                        <button
                            onClick={startRecording}
                            disabled={!isReady}
                            className={`group relative inline-flex items-center gap-3 px-8 py-4 bg-neutral-900 text-white rounded-full text-lg font-medium transition-all hover:scale-105 hover:shadow-xl
                            ${!isReady ? 'opacity-50 cursor-not-allowed' : 'hover:bg-neutral-800'}`}
                        >
                            {!isReady ? (
                                <span>Initializing Core...</span>
                            ) : (
                                <>
                                    <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></div>
                                    Start Recording
                                    <MonitorPlay className="w-5 h-5 ml-1 text-neutral-400 group-hover:text-white transition-colors" />
                                </>
                            )}
                        </button>
                    </div>
                )}

                {/* Recording State - Hidden Canvas (We render to offscreen/hidden canvas mostly, but we can show preview) */}
                {/* Actually, user might want to see what's being recorded. vzoneui hides it. 
                    Let's hide the main canvas during recording to focus on the content being recorded.
                    Or show a small confidence monitor?
                    Let's stick to vzoneui style: Minimal UI. 
                 */}
                <div className={`relative w-full aspect-video bg-black/5 rounded-2xl overflow-hidden shadow-inner border border-black/10 
                    ${isRecording ? 'opacity-0 pointer-events-none absolute' : ''} 
                    ${!isRecording && !previewBlobUrl ? 'hidden' : ''} 
                `}>
                    {/* Canvas for Previewing Blob or Live Stream (if we wanted) */}
                    {/* If we have a blob, show video element */}
                    {previewBlobUrl ? (
                        <video
                            src={previewBlobUrl}
                            controls
                            className="w-full h-full object-contain bg-black"
                        />
                    ) : (
                        /* This canvas is used by useRecorder to render frames. We keep it mounted but hidden if needed. */
                        <canvas ref={canvasRef} className="w-full h-full object-contain" />
                    )}
                </div>

                {/* Finished State Sidebar */}
                {previewBlobUrl && (
                    <div className="w-full flex justify-center gap-4 animate-in slide-in-from-bottom-4">
                        <a
                            href={previewBlobUrl}
                            download={`recording-${Date.now()}.mp4`}
                            className="px-8 py-3 bg-green-600 hover:bg-green-700 text-white rounded-xl font-medium shadow-lg hover:shadow-green-500/20 transition-all flex items-center gap-2"
                        >
                            <Download size={18} />
                            Download MP4
                        </a>
                    </div>
                )}

            </main>
        </div>
    );
};
