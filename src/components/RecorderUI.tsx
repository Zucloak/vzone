import React, { useState, useEffect, useRef } from 'react';
import { useRecorder } from '../hooks/useRecorder';
import { MonitorPlay, RotateCcw, Download, Zap } from 'lucide-react';
import { DraggableControls } from './DraggableControls';
import { BackgroundPicker } from './BackgroundPicker';
import { ZoomEditor } from './ZoomEditor';

export const RecorderUI: React.FC = () => {
    const {
        isRecording,
        isReady,
        startRecording,
        stopRecording,
        canvasRef,
        previewBlobUrl,
        setBackground,
        backgroundConfig,
        quality,
        setQuality,
        deviceCapability,
        recordedZoomEffects
    } = useRecorder();

    // Local state for UI feedback (timers, etc.) that mirrors the hook
    const [timer, setTimer] = useState(0);
    const timerInterval = React.useRef<number | null>(null);
    const popupRef = React.useRef<Window | null>(null);
    const previewVideoRef = useRef<HTMLVideoElement>(null);
    const [videoDuration, setVideoDuration] = useState(0);

    useEffect(() => {
        if (isRecording) {
            // Open Popup Toolbar
            popupRef.current = window.open(
                '/#controls',
                'MotionToolbar',
                'width=350,height=80,top=100,left=100,resizable=no,alwaysOnTop=yes'
            );
        } else {
            // Close Popup
            popupRef.current?.close();
            popupRef.current = null;
        }

        const handleMessage = (e: MessageEvent) => {
            if (e.data?.type === 'STOP_RECORDING') {
                // Multi-pronged approach to grab focus
                window.focus();
                setTimeout(() => window.focus(), 50);
                setTimeout(() => window.focus(), 200);

                // Force a document title change to grab attention
                const originalTitle = document.title;
                document.title = '🎬 Recording Stopped!';
                setTimeout(() => { document.title = originalTitle; }, 2000);

                stopRecording();
            }
        };
        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, [isRecording, stopRecording]);

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

    const getBackgroundStyle = () => {
        if (backgroundConfig.type === 'solid') return { backgroundColor: backgroundConfig.color };
        return { background: `linear-gradient(${backgroundConfig.direction || 'to right'}, ${backgroundConfig.startColor}, ${backgroundConfig.endColor})` };
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

            {/* Draggable Controls (Active during recording) */}
            {isRecording && (
                <DraggableControls
                    isPaused={false}
                    onPauseResume={() => { }}
                    onStop={stopRecording}
                    timer={timer}
                />
            )}

            <main className="w-full max-w-6xl flex flex-col items-center gap-8 z-0">

                {/* 1. IDLE STATE */}
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

                        {/* Device & Quality Settings */}
                        <div className="flex flex-col items-center gap-4 py-2">
                             {/* Device Tier Badge */}
                             <div className={`text-xs px-3 py-1 rounded-full border flex items-center gap-2 ${
                                deviceCapability.tier === 'high-end' ? 'bg-green-50 border-green-200 text-green-700' :
                                deviceCapability.tier === 'standard' ? 'bg-blue-50 border-blue-200 text-blue-700' :
                                'bg-orange-50 border-orange-200 text-orange-700'
                             }`}>
                                <span>
                                {deviceCapability.tier === 'high-end' ? '🚀 High-Performance Device Detected' :
                                 deviceCapability.tier === 'standard' ? '⚡ Standard Device Detected' :
                                 '⚠️ Low-Spec Device Detected'}
                                </span>
                             </div>

                             {/* Quality Selector */}
                             <div className="flex flex-col items-center gap-2">
                                <div className="flex bg-white border border-neutral-200 p-1 rounded-lg shadow-sm">
                                    <button
                                        onClick={() => setQuality('low')}
                                        className={`px-3 py-1 text-sm rounded-md transition-all ${quality === 'low' ? 'bg-neutral-900 text-white shadow-sm font-medium' : 'text-neutral-500 hover:text-neutral-900 hover:bg-neutral-50'}`}
                                    >
                                        Low
                                    </button>
                                    <button
                                        onClick={() => setQuality('high')}
                                        className={`px-3 py-1 text-sm rounded-md transition-all ${quality === 'high' ? 'bg-neutral-900 text-white shadow-sm font-medium' : 'text-neutral-500 hover:text-neutral-900 hover:bg-neutral-50'}`}
                                    >
                                        High
                                    </button>
                                    <button
                                        onClick={() => setQuality('highest')}
                                        disabled={!deviceCapability.canHandleHighest}
                                        title={!deviceCapability.canHandleHighest ? "Your device may struggle with Highest quality" : ""}
                                        className={`px-3 py-1 text-sm rounded-md transition-all ${quality === 'highest' ? 'bg-neutral-900 text-white shadow-sm font-medium' :
                                            !deviceCapability.canHandleHighest ? 'opacity-40 cursor-not-allowed text-neutral-300' : 'text-neutral-500 hover:text-neutral-900 hover:bg-neutral-50'}`}
                                    >
                                        Highest
                                    </button>
                                </div>
                                {!deviceCapability.canHandleHighest && (
                                    <p className="text-[10px] text-orange-600 max-w-xs font-medium bg-orange-50 px-2 py-1 rounded">
                                        "Highest" disabled for smooth recording
                                    </p>
                                )}
                             </div>
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

                {/* 2. RECORDING STATE (Hidden Canvas) */}
                {/* We keep the canvas mounted to drive the render loop, but hide it visually to let user focus on source */}
                <div className={`fixed inset-0 pointer-events-none opacity-0 ${isRecording ? 'block' : 'hidden'}`}>
                    <canvas ref={canvasRef} width={1920} height={1080} />
                </div>


                {/* 3. FINISHED / PREVIEW STATE */}
                {previewBlobUrl && (
                    <div className="w-full flex flex-col gap-6 animate-in fade-in slide-in-from-bottom-8 duration-700">
                        {/* Top row: Video + Sidebar */}
                        <div className="flex flex-col lg:flex-row gap-8 items-start">
                            {/* Video Container */}
                            <div
                                className="flex-1 aspect-video rounded-2xl shadow-2xl overflow-hidden relative flex items-center justify-center transition-all duration-500"
                                style={getBackgroundStyle()}
                            >
                                {/* Inner Video Frame */}
                                <div className="relative w-[85%] h-[85%] rounded-lg overflow-hidden shadow-lg bg-black">
                                    <video
                                        ref={previewVideoRef}
                                        src={previewBlobUrl}
                                        controls
                                        className="w-full h-full object-contain"
                                        onLoadedMetadata={(e) => {
                                            const video = e.target as HTMLVideoElement;
                                            setVideoDuration(video.duration);
                                        }}
                                    />
                                </div>
                            </div>

                            {/* Sidebar */}
                            <div className="w-full lg:w-80 space-y-4 p-1">
                                <div className="bg-white p-6 rounded-2xl shadow-sm border border-neutral-100">
                                    <h3 className="text-sm font-bold text-neutral-900 mb-4 flex items-center gap-2">
                                        <Zap size={16} className="text-yellow-500" />
                                        Ready to Export
                                    </h3>
                                    <div className="text-sm text-neutral-600 mb-4">
                                        Your recording is processed and ready.
                                    </div>

                                    <div className="border-t border-neutral-100 my-6"></div>
                                    <h3 className="text-sm font-bold text-neutral-900 mb-4">Choose Background</h3>
                                    <BackgroundPicker config={backgroundConfig} onChange={setBackground} />
                                </div>

                                <button
                                    onClick={() => {
                                        const a = document.createElement('a');
                                        a.href = previewBlobUrl;
                                        a.download = `vzone-recording-${Date.now()}.mp4`;
                                        document.body.appendChild(a);
                                        a.click();
                                        document.body.removeChild(a);
                                    }}
                                    className="w-full py-4 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-medium shadow-lg hover:shadow-blue-500/20 transition-all flex justify-center items-center gap-2"
                                >
                                    <Download size={18} />
                                    Download MP4
                                </button>
                            </div>
                        </div>

                        {/* Zoom Editor - Below video */}
                        {videoDuration > 0 && (
                            <ZoomEditor 
                                key="zoom-editor"
                                videoRef={previewVideoRef}
                                videoDuration={videoDuration}
                                initialZoomEffects={recordedZoomEffects}
                            />
                        )}
                    </div>
                )}
            </main>
        </div>
    );
};
