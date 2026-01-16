import React from 'react';
import { useRecorder } from '../hooks/useRecorder';

export const RecorderUI: React.FC = () => {
    const { isRecording, startRecording, stopRecording, canvasRef, isReady } = useRecorder();

    return (
        <div className="min-h-screen flex flex-col items-center justify-center relative overflow-hidden">
            {/* Dynamic Background */}
            <div className="gradient-bg"></div>

            <div className="z-10 bg-white/10 backdrop-blur-xl border border-white/20 rounded-3xl p-8 shadow-2xl max-w-4xl w-full flex flex-col items-center gap-6">
                <h1 className="text-4xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-apple-dark to-gray-600">
                    Motion Screen Recorder
                </h1>

                <div className="relative group w-full aspect-video bg-black/5 rounded-2xl overflow-hidden border border-white/10 shadow-inner">
                    <canvas
                        ref={canvasRef}
                        className="w-full h-full object-contain"
                    />
                    {!isRecording && (
                        <div className="absolute inset-0 flex items-center justify-center text-gray-400">
                            {!isReady ? "Initializing Core..." : "Preview Area"}
                        </div>
                    )}
                </div>

                <div className="flex gap-4">
                    {!isRecording ? (
                        <button
                            onClick={startRecording}
                            disabled={!isReady}
                            className={`px-8 py-3 bg-apple-dark text-white rounded-full font-medium shadow-lg transition-all
                                ${!isReady ? 'opacity-50 cursor-not-allowed' : 'hover:scale-105 active:scale-95'}`}
                        >
                            Start Recording
                        </button>
                    ) : (
                        <button
                            onClick={stopRecording}
                            className="px-8 py-3 bg-red-500 text-white rounded-full font-medium hover:scale-105 transition-all shadow-lg active:scale-95 animate-pulse"
                        >
                            Stop Recording
                        </button>
                    )}
                </div>

                <p className="text-sm text-gray-500 font-light">
                    Move your mouse to control the camera.
                </p>
            </div>
        </div>
    );
};
