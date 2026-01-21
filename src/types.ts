export type ZoomEffect = {
    id: string;
    timestamp: number; // ms relative to start
    duration: number; // ms
    zoomLevel: number; // scale factor (e.g., 1.5)
    cursorPosition: { x: number; y: number }; // normalized 0-1
};

export type BackgroundType = 'solid' | 'gradient';

export type BackgroundConfig = {
    type: BackgroundType;
    color: string;
    startColor?: string;
    endColor?: string;
    direction?: string;
};

export type RecordingState = 'idle' | 'recording' | 'paused' | 'processing' | 'finished';

export interface ProcessingStatus {
    stage: string;
    progress: number; // 0-100
}

export type VideoQuality = 'highest' | 'high' | 'low';

export interface DeviceCapability {
    cpuCores: number;
    memory?: number; // RAM in GB (approx)
    canHandleHighest: boolean;
    tier: 'high-end' | 'standard' | 'low-end';
}
