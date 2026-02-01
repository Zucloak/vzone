import React, { useState, useRef, useEffect } from 'react';
import { Plus, Trash2, ZoomIn, ZoomOut, Clock } from 'lucide-react';
import type { ZoomEffect } from '../types';

interface ZoomEditorProps {
    videoRef: React.RefObject<HTMLVideoElement | null>;
    videoDuration: number; // in seconds
    initialZoomEffects?: ZoomEffect[]; // Zoom effects recorded during recording
    onZoomEffectsChange?: (effects: ZoomEffect[]) => void;
}

export const ZoomEditor: React.FC<ZoomEditorProps> = ({
    videoRef,
    videoDuration,
    initialZoomEffects = [],
    onZoomEffectsChange
}) => {
    // Track if we've initialized from props to avoid re-setting after user edits
    const hasInitializedRef = useRef(false);
    const [zoomEffects, setZoomEffects] = useState<ZoomEffect[]>([]);
    const [selectedEffect, setSelectedEffect] = useState<string | null>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [dragType, setDragType] = useState<'move' | 'resize-start' | 'resize-end' | null>(null);
    const timelineRef = useRef<HTMLDivElement>(null);
    const [currentTime, setCurrentTime] = useState(0);
    
    // Initialize with recorded zoom effects ONCE when they become available
    // Use a ref to track the initial effects to avoid re-initialization
    useEffect(() => {
        if (initialZoomEffects.length > 0 && !hasInitializedRef.current) {
            console.log('ZoomEditor: Initializing with', initialZoomEffects.length, 'effects');
            setZoomEffects([...initialZoomEffects]); // Clone the array
            hasInitializedRef.current = true;
        }
    }, [initialZoomEffects.length]); // Only depend on length, not the array itself

    // Sync with video time
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        const handleTimeUpdate = () => {
            setCurrentTime(video.currentTime);
        };

        video.addEventListener('timeupdate', handleTimeUpdate);
        return () => video.removeEventListener('timeupdate', handleTimeUpdate);
    }, [videoRef]);

    // Notify parent of changes
    useEffect(() => {
        onZoomEffectsChange?.(zoomEffects);
    }, [zoomEffects, onZoomEffectsChange]);

    const generateId = () => Math.random().toString(36).substr(2, 9);

    const addZoomEffect = () => {
        const video = videoRef.current;
        const startTime = video ? video.currentTime * 1000 : 0;
        
        const newEffect: ZoomEffect = {
            id: generateId(),
            timestamp: startTime,
            duration: 2000, // 2 seconds default
            zoomLevel: 1.6,
            cursorPosition: { x: 0.5, y: 0.5 } // center
        };

        setZoomEffects(prev => [...prev, newEffect].sort((a, b) => a.timestamp - b.timestamp));
        setSelectedEffect(newEffect.id);
    };

    const removeZoomEffect = (id: string) => {
        setZoomEffects(prev => prev.filter(e => e.id !== id));
        if (selectedEffect === id) setSelectedEffect(null);
    };

    const updateZoomEffect = (id: string, updates: Partial<ZoomEffect>) => {
        setZoomEffects(prev => prev.map(e => 
            e.id === id ? { ...e, ...updates } : e
        ));
    };

    const handleTimelineClick = (e: React.MouseEvent) => {
        if (!timelineRef.current || isDragging) return;
        
        const rect = timelineRef.current.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const clickPercent = clickX / rect.width;
        const clickTime = clickPercent * videoDuration;

        // Seek video to clicked position
        if (videoRef.current) {
            videoRef.current.currentTime = clickTime;
        }
    };

    const handleEffectMouseDown = (e: React.MouseEvent, effectId: string, type: 'move' | 'resize-start' | 'resize-end') => {
        e.stopPropagation();
        setSelectedEffect(effectId);
        setIsDragging(true);
        setDragType(type);
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        if (!isDragging || !selectedEffect || !timelineRef.current) return;

        const rect = timelineRef.current.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mousePercent = Math.max(0, Math.min(1, mouseX / rect.width));
        const mouseTimeMs = mousePercent * videoDuration * 1000;

        const effect = zoomEffects.find(e => e.id === selectedEffect);
        if (!effect) return;

        if (dragType === 'move') {
            // Move the entire effect
            const newTimestamp = Math.max(0, Math.min(
                videoDuration * 1000 - effect.duration,
                mouseTimeMs - effect.duration / 2
            ));
            updateZoomEffect(selectedEffect, { timestamp: newTimestamp });
        } else if (dragType === 'resize-start') {
            // Resize from start
            const endTime = effect.timestamp + effect.duration;
            const newTimestamp = Math.max(0, Math.min(endTime - 500, mouseTimeMs));
            const newDuration = endTime - newTimestamp;
            updateZoomEffect(selectedEffect, { timestamp: newTimestamp, duration: newDuration });
        } else if (dragType === 'resize-end') {
            // Resize from end
            const newDuration = Math.max(500, Math.min(
                videoDuration * 1000 - effect.timestamp,
                mouseTimeMs - effect.timestamp
            ));
            updateZoomEffect(selectedEffect, { duration: newDuration });
        }
    };

    const handleMouseUp = () => {
        setIsDragging(false);
        setDragType(null);
    };

    const formatTime = (seconds: number) => {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    const selectedEffectData = selectedEffect ? zoomEffects.find(e => e.id === selectedEffect) : null;

    return (
        <div className="bg-white rounded-xl border border-neutral-200 p-4 space-y-4">
            <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-neutral-900 flex items-center gap-2">
                    <ZoomIn size={16} className="text-blue-500" />
                    Zoom Timeline Editor
                </h3>
                <button
                    onClick={addZoomEffect}
                    className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 transition-colors"
                >
                    <Plus size={14} />
                    Add Zoom
                </button>
            </div>

            {/* Timeline */}
            <div 
                ref={timelineRef}
                className="relative h-16 bg-neutral-100 rounded-lg overflow-hidden cursor-pointer"
                onClick={handleTimelineClick}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
            >
                {/* Time markers */}
                <div className="absolute inset-x-0 top-0 h-4 flex justify-between px-2 text-[10px] text-neutral-400">
                    <span>0:00</span>
                    <span>{formatTime(videoDuration / 2)}</span>
                    <span>{formatTime(videoDuration)}</span>
                </div>

                {/* Zoom effects */}
                <div className="absolute inset-x-0 top-5 bottom-1 px-1">
                    {zoomEffects.map(effect => {
                        const leftPercent = (effect.timestamp / (videoDuration * 1000)) * 100;
                        const widthPercent = (effect.duration / (videoDuration * 1000)) * 100;
                        const isSelected = effect.id === selectedEffect;

                        return (
                            <div
                                key={effect.id}
                                className={`absolute top-0 bottom-0 rounded cursor-move transition-colors ${
                                    isSelected 
                                        ? 'bg-blue-500 ring-2 ring-blue-300' 
                                        : 'bg-blue-400 hover:bg-blue-500'
                                }`}
                                style={{
                                    left: `${leftPercent}%`,
                                    width: `${Math.max(1, widthPercent)}%`,
                                    minWidth: '20px'
                                }}
                                onMouseDown={(e) => handleEffectMouseDown(e, effect.id, 'move')}
                            >
                                {/* Resize handles */}
                                <div 
                                    className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-blue-600 rounded-l"
                                    onMouseDown={(e) => handleEffectMouseDown(e, effect.id, 'resize-start')}
                                />
                                <div 
                                    className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-blue-600 rounded-r"
                                    onMouseDown={(e) => handleEffectMouseDown(e, effect.id, 'resize-end')}
                                />
                                
                                {/* Zoom level indicator */}
                                <div className="absolute inset-0 flex items-center justify-center text-[10px] text-white font-medium pointer-events-none">
                                    {effect.zoomLevel.toFixed(1)}x
                                </div>
                            </div>
                        );
                    })}
                </div>

                {/* Playhead */}
                <div 
                    className="absolute top-0 bottom-0 w-0.5 bg-red-500 pointer-events-none z-10"
                    style={{ left: `${(currentTime / videoDuration) * 100}%` }}
                >
                    <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-red-500 rounded-full" />
                </div>
            </div>

            {/* Selected effect controls */}
            {selectedEffectData && (
                <div className="flex flex-wrap gap-4 p-3 bg-neutral-50 rounded-lg">
                    <div className="flex items-center gap-2">
                        <Clock size={14} className="text-neutral-400" />
                        <span className="text-xs text-neutral-500">Start:</span>
                        <input
                            type="number"
                            value={(selectedEffectData.timestamp / 1000).toFixed(1)}
                            onChange={(e) => updateZoomEffect(selectedEffectData.id, { 
                                timestamp: parseFloat(e.target.value) * 1000 
                            })}
                            className="w-16 px-2 py-1 text-xs border border-neutral-200 rounded"
                            step="0.1"
                            min="0"
                        />
                        <span className="text-xs text-neutral-400">s</span>
                    </div>

                    <div className="flex items-center gap-2">
                        <span className="text-xs text-neutral-500">Duration:</span>
                        <input
                            type="number"
                            value={(selectedEffectData.duration / 1000).toFixed(1)}
                            onChange={(e) => updateZoomEffect(selectedEffectData.id, { 
                                duration: parseFloat(e.target.value) * 1000 
                            })}
                            className="w-16 px-2 py-1 text-xs border border-neutral-200 rounded"
                            step="0.1"
                            min="0.5"
                        />
                        <span className="text-xs text-neutral-400">s</span>
                    </div>

                    <div className="flex items-center gap-2">
                        <ZoomIn size={14} className="text-neutral-400" />
                        <span className="text-xs text-neutral-500">Zoom:</span>
                        <input
                            type="range"
                            value={selectedEffectData.zoomLevel}
                            onChange={(e) => updateZoomEffect(selectedEffectData.id, { 
                                zoomLevel: parseFloat(e.target.value) 
                            })}
                            className="w-20"
                            step="0.1"
                            min="1.2"
                            max="2.5"
                        />
                        <span className="text-xs font-medium">{selectedEffectData.zoomLevel.toFixed(1)}x</span>
                    </div>

                    <button
                        onClick={() => removeZoomEffect(selectedEffectData.id)}
                        className="flex items-center gap-1 px-2 py-1 text-xs text-red-600 hover:bg-red-50 rounded transition-colors ml-auto"
                    >
                        <Trash2 size={12} />
                        Remove
                    </button>
                </div>
            )}

            {/* Empty state */}
            {zoomEffects.length === 0 && (
                <div className="text-center py-4 text-neutral-400 text-sm">
                    <ZoomOut size={24} className="mx-auto mb-2 opacity-50" />
                    No zoom effects yet. Click "Add Zoom" to create one at the current playhead position.
                </div>
            )}

            {/* Instructions */}
            <div className="text-[10px] text-neutral-400 space-y-1">
                <p>• Drag zoom blocks to move them on the timeline</p>
                <p>• Drag edges to resize duration</p>
                <p>• Click timeline to seek video</p>
            </div>
            
            {/* Limitation note */}
            <div className="mt-3 p-2 bg-amber-50 border border-amber-200 rounded-lg">
                <p className="text-[10px] text-amber-700">
                    <strong>Note:</strong> This timeline shows zoom events from your recording. 
                    Edits here are for review purposes. Re-record to apply different zoom timing.
                </p>
            </div>
        </div>
    );
};
