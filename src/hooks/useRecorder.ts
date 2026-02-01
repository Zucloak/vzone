import type { BackgroundConfig, VideoQuality, DeviceCapability } from '../types';
import { useState, useRef, useEffect, useCallback } from 'react';
import init, { CameraRig, Mp4Muxer } from '../../recorder_core/pkg/recorder_core';
import { getCaretCoordinates, isTypingActive, isIgnoredKey } from '../utils/caretTracking';

// Motion detection configuration (tuned for 64x36 analysis buffer)
const MOTION_CONFIG = {
    // Pixel change detection
    THRESHOLD: 18,              // RGB diff threshold - balanced to detect clicks but not subtle hovers
    MIN_MASS: 4,                // Minimum changed pixels to register motion
    
    // Scroll detection (dimensions in analysis buffer coordinate space)
    SCROLL_HEIGHT_THRESHOLD: 8,  // Height change indicating scroll (out of 36 pixels)
    SCROLL_WIDTH_THRESHOLD: 50,  // Width change indicating scroll (out of 64 pixels)
    LOCALIZED_ACTION_AREA: 150,  // Max area for click/type actions (pixels²)
    
    // Zoom triggers - balanced for real clicks
    ZOOM_MIN_MASS: 5,           // Minimum mass to trigger zoom - balanced
    ZOOM_MAX_VELOCITY: 60,      // Max velocity for zoom-in (pixels/frame)
    ZOOM_OUT_VELOCITY: 80,      // Velocity threshold for zoom-out
    MOUSE_OVERRIDE_THRESHOLD: 5, // Minimum motion to override typing mode
    
    // Click tracking (Cursorful-style multi-click trigger)
    // Auto zoom triggered when 2+ clicks within 3 second window
    // Two-click requirement prevents zoom from hover effects
    CLICK_WINDOW_MS: 3000,      // Time window for click tracking (3 seconds)
    MIN_CLICKS_TO_ZOOM: 2,      // Minimum clicks required to trigger zoom (2 clicks = intentional)
    
    // Smoothing - Higher values = more responsive, lower = slower/cinematic
    TARGET_SMOOTHING: 0.4,      // Lerp factor for cursor following when zoomed
    TARGET_SMOOTHING_CLICK: 0.6, // Smoothing on clicks
    
    // Zoom levels
    ZOOM_IN_LEVEL: 1.6,         // Zoom level for focused actions (1.6x)
    ZOOM_OUT_LEVEL: 1.0,        // Zoom level for overview (scrolling, idle)
} as const;

// Encoder output callback processing delay (brief wait after flush for callbacks to complete)
const ENCODER_OUTPUT_DELAY_MS = 50;

export const useRecorder = () => {
    const [isRecording, setIsRecording] = useState(false);
    const [isReady, setIsReady] = useState(false);
    const [stream, setStream] = useState<MediaStream | null>(null);
    const [previewBlobUrl, setPreviewBlobUrl] = useState<string | null>(null);

    // Settings
    const [quality, setQuality] = useState<VideoQuality>('high');
    const [deviceCapability, setDeviceCapability] = useState<DeviceCapability>({
        cpuCores: 4,
        canHandleHighest: true,
        tier: 'standard'
    });

    const canvasRef = useRef<HTMLCanvasElement>(null);
    const requestRef = useRef<number>(0);
    const muxerRef = useRef<Mp4Muxer | null>(null);
    const rigRef = useRef<CameraRig | null>(null);
    const videoEncoderRef = useRef<VideoEncoder | null>(null);
    const frameCountRef = useRef(0);
    const warmupFramesRef = useRef(0);
    const startTimeRef = useRef<number>(0);

    // Background State
    const [backgroundConfig, setBackgroundConfig] = useState<BackgroundConfig>({ type: 'solid', color: '#171717' });
    const backgroundRef = useRef<BackgroundConfig>({ type: 'solid', color: '#171717' });

    const motionCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const motionContextRef = useRef<CanvasRenderingContext2D | null>(null);
    const prevFrameDataRef = useRef<Uint8ClampedArray | null>(null);
    const lastMotionTimeRef = useRef<number>(0);
    const currentTargetRef = useRef({ x: 960, y: 540 }); // Smooth target tracking
    const prevDetectedTargetRef = useRef({ x: 960, y: 540 }); // For velocity calc
    const workerRef = useRef<Worker | null>(null);
    const isProcessorActiveRef = useRef(false);
    const isStoppingRef = useRef(false);
    const videoElementRef = useRef<HTMLVideoElement | null>(null);
    
    // Typing Detection State
    const lastKeyTimeRef = useRef<number>(0); // Timestamp of last key press
    const typingTargetRef = useRef<{ x: number; y: number } | null>(null); // Last known caret position
    const isTypingModeRef = useRef(false); // Whether we're currently in typing mode
    const keydownHandlerRef = useRef<((e: KeyboardEvent) => void) | null>(null); // Store handler for cleanup
    
    // Click Tracking State (Cursorful-style multi-click trigger)
    const clickTimestampsRef = useRef<number[]>([]); // Track timestamps of recent clicks
    const zoomEnabledRef = useRef(false); // Whether zoom is enabled (2+ clicks detected)
    
    // Zoom Events Tracking - Record zoom events during recording for editor
    const [recordedZoomEffects, setRecordedZoomEffects] = useState<Array<{
        id: string;
        timestamp: number;
        duration: number;
        zoomLevel: number;
        cursorPosition: { x: number; y: number };
    }>>([]);
    const currentZoomEventRef = useRef<{ startTime: number; x: number; y: number } | null>(null);
    const zoomEventsRef = useRef<Array<{
        id: string;
        timestamp: number;
        duration: number;
        zoomLevel: number;
        cursorPosition: { x: number; y: number };
    }>>([]);

    useEffect(() => {
        // Init Wasm
        init().then(() => {
            console.log("Wasm module initialized");
            setIsReady(true);
        });

        // Initialize motion canvas
        const mCanvas = document.createElement('canvas');
        mCanvas.width = 64; // Low res for performance
        mCanvas.height = 36;
        motionCanvasRef.current = mCanvas;
        motionContextRef.current = mCanvas.getContext('2d', { willReadFrequently: true });

        // Init Worker
        workerRef.current = new Worker(new URL('../workers/timer.worker.ts', import.meta.url), { type: 'module' });

        return () => {
            workerRef.current?.terminate();
        };
    }, []);

    // Device Detection
    useEffect(() => {
        const cores = navigator.hardwareConcurrency || 4;
        // @ts-ignore - deviceMemory is experimental
        const ram = (navigator as any).deviceMemory || 4;

        let tier: DeviceCapability['tier'] = 'standard';
        let canHandleHighest = true;
        let recommendedQuality: VideoQuality = 'high';

        if (cores >= 8 && ram >= 8) {
            tier = 'high-end';
            recommendedQuality = 'highest';
        } else if (cores < 4 || ram < 4) {
            tier = 'low-end';
            canHandleHighest = false;
            recommendedQuality = 'low';
        }

        console.log(`💻 Device Detection: Cores=${cores}, RAM=${ram}GB, Tier=${tier}`);

        setDeviceCapability({
            cpuCores: cores,
            memory: ram,
            canHandleHighest,
            tier
        });
        setQuality(recommendedQuality);
    }, []);

    const setBackground = useCallback((config: BackgroundConfig) => {
        setBackgroundConfig(config);
        backgroundRef.current = config;
    }, []);

    const stopRecording = useCallback(async () => {
        // Prevent double entry with a dedicated flag
        if (isStoppingRef.current) return;
        isStoppingRef.current = true;
        
        isProcessorActiveRef.current = false;
        
        console.log("🛑 stopRecording called - stopping worker and frame generation");
        
        // Save recorded zoom events before cleanup
        // If there's an ongoing zoom, end it now
        if (currentZoomEventRef.current && startTimeRef.current > 0) {
            const elapsedMs = performance.now() - startTimeRef.current;
            const zoomEvent = {
                id: Math.random().toString(36).substr(2, 9),
                timestamp: currentZoomEventRef.current.startTime,
                duration: Math.max(500, elapsedMs - currentZoomEventRef.current.startTime),
                zoomLevel: MOTION_CONFIG.ZOOM_IN_LEVEL,
                cursorPosition: {
                    x: currentZoomEventRef.current.x,
                    y: currentZoomEventRef.current.y
                }
            };
            zoomEventsRef.current.push(zoomEvent);
            currentZoomEventRef.current = null;
        }
        // Store the recorded zoom effects for the editor
        setRecordedZoomEffects([...zoomEventsRef.current]);
        console.log(`📍 Recorded ${zoomEventsRef.current.length} zoom events`);

        try {
            // Stop Worker Loop first to prevent new frames
            workerRef.current?.postMessage('stop');

            // Clear any lingering interval if it exists (though we use worker now)
            if (requestRef.current) {
                clearInterval(requestRef.current);
                requestRef.current = 0;
            }

            // Bring focus back to this window
            window.focus();
            
            // Remove keyboard event listener
            if (keydownHandlerRef.current) {
                window.removeEventListener('keydown', keydownHandlerRef.current);
                keydownHandlerRef.current = null;
            }
            
            // Reset typing state
            isTypingModeRef.current = false;
            typingTargetRef.current = null;
            lastKeyTimeRef.current = 0;

            // CRITICAL: Flush encoder IMMEDIATELY before it can auto-close
            // When the video track ends, some browsers will close the encoder
            // So we must flush right away to capture all pending output
            if (videoEncoderRef.current) {
                try {
                    const encoderState = videoEncoderRef.current.state;
                    console.log("Encoder state before flush:", encoderState);
                    
                    if (encoderState === 'configured') {
                        await videoEncoderRef.current.flush();
                        console.log("Encoder flushed successfully");
                    }
                    
                    // Close encoder after flush
                    if (videoEncoderRef.current.state !== 'closed') {
                        videoEncoderRef.current.close();
                        console.log("Encoder closed successfully");
                    }
                } catch (e) {
                    console.error(`Encoder cleanup error (non-critical, continuing with cleanup). State was: ${videoEncoderRef.current?.state}`, e);
                    // Force close if still open after error
                    try {
                        if (videoEncoderRef.current?.state !== 'closed') {
                            videoEncoderRef.current?.close();
                        }
                    } catch (closeError) {
                        console.error("Error force-closing encoder:", closeError);
                    }
                }
                videoEncoderRef.current = null;
            }

            // Brief delay to ensure all encoder output callbacks have fired
            // This is much shorter than before since we already flushed
            await new Promise(resolve => setTimeout(resolve, ENCODER_OUTPUT_DELAY_MS));

            // Finalize muxer BEFORE stopping stream and UI updates
            // The muxer needs to finish writing before we clean up everything
            let videoBlob: Blob | null = null;
            if (muxerRef.current) {
                try {
                    const bytes = muxerRef.current.finish();
                    console.log("Muxer finished. Total bytes:", bytes.length);

                    if (bytes.length < 1000) {
                        console.warn("⚠️ Warning: Video file is surprisingly small (<1KB). Recording might have failed.");
                        alert("Warning: Recording seems empty. Please check permissions / console.");
                    }

                    // Use video/mp4 for correct format detection
                    videoBlob = new Blob([bytes as unknown as BlobPart], { type: 'video/mp4' });
                } catch (e) {
                    console.error("Muxer finish failed:", e);
                    alert("Muxer Error on Finish: " + e);
                }
                muxerRef.current = null;
            } else {
                console.warn("Muxer was null in stopRecording! No video data.");
                alert("No video data was recorded. (Muxer not initialized - did recording start?)");
            }

            // NOW we can safely stop the media stream and update UI
            // Encoder is fully flushed/closed, muxer is done, frames are complete
            if (stream) {
                stream.getTracks().forEach(t => t.stop());
                setStream(null);
            }

            // Update UI state - this will hide the canvas
            setIsRecording(false);

            // Set the preview URL if we got a video blob
            if (videoBlob) {
                const url = URL.createObjectURL(videoBlob);
                console.log("Setting preview URL:", url);
                setPreviewBlobUrl(url);
            }
        } catch (err) {
            console.error("Critical error in stopRecording:", err);
            setIsRecording(false);
        }
    }, [stream]);

    const startRecording = useCallback(async () => {
        let displayMedia: MediaStream | null = null;
        try {
            // Reset stopping flag for new recording
            isStoppingRef.current = false;
            
            displayMedia = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    width: { ideal: 1920 },
                    height: { ideal: 1080 },
                    frameRate: 30, // 30fps to match encoder settings for smooth recording
                },
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    sampleRate: 44100
                }
            });

            setStream(displayMedia);
            setPreviewBlobUrl(null);
            warmupFramesRef.current = 0; // Reset warmup counter
            frameCountRef.current = 0; // Reset frame counter for new recording
            startTimeRef.current = 0; // Reset start time for new recording timestamps
            lastMotionTimeRef.current = Date.now();
            
            // Reset click tracking state for new recording
            clickTimestampsRef.current = [];
            zoomEnabledRef.current = false;
            
            // Reset typing state for clean start
            lastKeyTimeRef.current = 0;
            isTypingModeRef.current = false;
            typingTargetRef.current = null;
            
            // Reset zoom events tracking for new recording
            zoomEventsRef.current = [];
            currentZoomEventRef.current = null;
            setRecordedZoomEffects([]);

            const track = displayMedia.getVideoTracks()[0];
            const settings = track.getSettings();
            const width = settings.width || 1920;
            const height = settings.height || 1080;

            console.log(`🎥 Source resolution detected: ${width}x${height}`);

            // Initialize Camera Rig with actual dimensions
            rigRef.current = new CameraRig(width, height);
            
            // CRITICAL: Initialize zoom to overview level to prevent random startup zooming
            rigRef.current.set_target_zoom(MOTION_CONFIG.ZOOM_OUT_LEVEL);

            // Set initial target to center of actual screen
            currentTargetRef.current = { x: width / 2, y: height / 2 };
            prevDetectedTargetRef.current = { x: width / 2, y: height / 2 };

            // Initialize VideoEncoder with robust configuration for animated content
            const encoder = new VideoEncoder({
                output: (chunk, metadata) => {
                    // ALWAYS process encoder output, even during shutdown
                    // The encoder's flush() will ensure all pending chunks are processed
                    // before we finalize the muxer.
                    
                    // Log first output for debugging
                    if (!muxerRef.current) {
                        console.log(`📦 Encoder output received: chunk type=${chunk.type}, size=${chunk.byteLength}, hasDescription=${!!metadata?.decoderConfig?.description}`);
                    }
                    
                    // Lazy init Muxer once we have the codec config (SPS/PPS)
                    if (!muxerRef.current && metadata?.decoderConfig?.description) {
                        const description = new Uint8Array(metadata.decoderConfig.description as ArrayBuffer);
                        console.log("✅ Initializing Muxer with AVCC config, length:", description.length);
                        try {
                            muxerRef.current = new Mp4Muxer(width, height, description);
                            console.log("✅ Muxer initialized successfully");
                        } catch (e) {
                            console.error("❌ Failed to create Muxer:", e);
                            return;
                        }
                    }

                    if (muxerRef.current) {
                        const buffer = new Uint8Array(chunk.byteLength);
                        chunk.copyTo(buffer);
                        // Muxer uses timescale: 1,000,000 (microseconds) to match VideoFrame
                        muxerRef.current.add_frame(
                            buffer,
                            chunk.type === 'key',
                            BigInt(chunk.timestamp)
                        );
                    }
                },
                error: (e) => {
                    // Only log error if we're not already stopping (expected during shutdown)
                    if (isProcessorActiveRef.current) {
                        console.error("❌ VideoEncoder error:", e);
                    } else {
                        console.log("VideoEncoder error during shutdown (expected):", e.message);
                    }
                    // Stop processing immediately on encoder error to prevent cascade failures
                    isProcessorActiveRef.current = false;
                    workerRef.current?.postMessage('stop');
                },
            });

            // Configure encoder with settings optimized for screen recording
            // Use 'realtime' latency mode to ensure frames are output immediately
            // This prevents the encoder from buffering too many frames which can cause
            // issues when the video track ends abruptly

            // Bitrate selection based on quality setting
            // Higher bitrates for screen content which has sharp edges and text
            let targetBitrate = 12_000_000; // Default Highest: 12 Mbps (good for 1080p screen content)
            if (quality === 'high') targetBitrate = 8_000_000; // High: 8 Mbps
            if (quality === 'low') targetBitrate = 4_000_000;   // Low: 4 Mbps

            console.log(`⚙️ Configuring Encoder: Quality=${quality}, Bitrate=${targetBitrate/1000000}Mbps, Resolution=${width}x${height}`);

            // Use Baseline Profile Level 4.0 for 1080p support with maximum compatibility
            // Level 4.0 supports up to 1920x1080 at 30fps (needed for full HD recording)
            // Using 'prefer-software' and 'realtime' to ensure immediate, reliable output
            // Some hardware encoders buffer frames aggressively which causes issues when
            // the video track ends abruptly (muxer never gets initialized)
            encoder.configure({
                codec: 'avc1.420028', // Baseline Profile, Level 4.0 - supports 1080p30
                width: width,
                height: height,
                bitrate: targetBitrate,
                framerate: 30,
                hardwareAcceleration: 'prefer-software', // More reliable output than hardware encoding
                latencyMode: 'realtime', // CRITICAL: Output frames immediately, don't buffer
            });
            
            console.log(`✅ Encoder configured, state: ${encoder.state}`);
            videoEncoderRef.current = encoder;

            // Setup Render Loop
            const video = document.createElement('video');
            video.srcObject = displayMedia;
            video.muted = true; // Important for autoplay
            videoElementRef.current = video;
            
            // Add video error handler
            video.onerror = (e) => {
                console.error("Video element error:", e);
                isProcessorActiveRef.current = false;
                workerRef.current?.postMessage('stop');
            };
            
            video.play();
            
            // Keyboard Event Listener for Typing Zoom
            const handleKeydown = (e: KeyboardEvent) => {
                // Ignore modifier and navigation keys that don't represent typing
                if (isIgnoredKey(e.key)) {
                    return;
                }
                
                // Check if user is actively typing in an input element
                if (isTypingActive()) {
                    lastKeyTimeRef.current = Date.now();
                    isTypingModeRef.current = true;
                    
                    // Try to get caret coordinates
                    const caretPos = getCaretCoordinates();
                    if (caretPos) {
                        // NOTE: Screen coordinates are used directly.
                        // For multi-monitor setups, this may need adjustment based on
                        // the display media's actual screen position. This is a known
                        // limitation documented in TARGETED_ZOOM_IMPLEMENTATION.md
                        typingTargetRef.current = caretPos;
                    }
                }
            };
            
            keydownHandlerRef.current = handleKeydown;
            window.addEventListener('keydown', handleKeydown);
            
            // Physics counter for smooth camera at 60fps while encoding at 30fps
            let physicsFrameCount = 0;

            const draw = () => {
                if (!isProcessorActiveRef.current) return;
                
                warmupFramesRef.current++;
                
                // Performance optimization: Skip expensive motion detection during warmup
                // Since zoom is disabled anyway, we don't need to track cursor
                const isWarmupPeriod = warmupFramesRef.current < 90;
                
                // Log warmup completion for debugging
                if (warmupFramesRef.current === 90) {
                    console.log("✅ Warmup period complete - full motion tracking enabled");
                }

                // Check if video is still valid and has data
                if (!video || video.readyState < 2) {
                    console.warn("Video not ready, skipping frame");
                    return;
                }

                if (frameCountRef.current % 60 === 0) {
                    console.log(`🎨 draw() called for frame ${frameCountRef.current}`);
                }

                if (!canvasRef.current) {
                    console.error("❌ canvasRef.current is null!");
                    return;
                }
                if (!rigRef.current) {
                    console.error("❌ rigRef.current is null!");
                    return;
                }

                const ctx = canvasRef.current.getContext('2d');
                if (!ctx) {
                    console.error("❌ canvas context is null!");
                    return;
                }

                // --- Motion Detection Logic ---
                let detectedX = currentTargetRef.current.x;
                let detectedY = currentTargetRef.current.y;

                // Skip motion detection during warmup period for performance
                if (!isWarmupPeriod && motionContextRef.current && prevFrameDataRef.current) {
                    const mCtx = motionContextRef.current;
                    // Draw small frame
                    mCtx.drawImage(video, 0, 0, 64, 36);
                    const frameData = mCtx.getImageData(0, 0, 64, 36).data;
                    const prevData = prevFrameDataRef.current;

                    let totalX = 0;
                    let totalY = 0;
                    let totalMass = 0;

                    // Bounding Box of changes (0-63, 0-35)
                    let minX = 64, maxX = 0;
                    let minY = 36, maxY = 0;

                    for (let i = 0; i < frameData.length; i += 4) {
                        // Simple luminosity diff
                        const rDiff = Math.abs(frameData[i] - prevData[i]);
                        const gDiff = Math.abs(frameData[i + 1] - prevData[i + 1]);
                        const bDiff = Math.abs(frameData[i + 2] - prevData[i + 2]);

                        // Check if pixel changed significantly
                        if (rDiff + gDiff + bDiff > MOTION_CONFIG.THRESHOLD) {
                            const pixelIdx = i / 4;
                            const x = pixelIdx % 64;
                            const y = Math.floor(pixelIdx / 64);

                            totalX += x;
                            totalY += y;
                            totalMass++;

                            // Update Bounding Box
                            if (x < minX) minX = x;
                            if (x > maxX) maxX = x;
                            if (y < minY) minY = y;
                            if (y > maxY) maxY = y;
                        }
                    }

                    // Save current frame for next loop
                    prevFrameDataRef.current.set(frameData);

                    // If enough pixels changed, update target
                    if (totalMass > MOTION_CONFIG.MIN_MASS) {
                        // Scale back up to Source Dimensions
                        const avgX = (totalX / totalMass) * (width / 64);
                        const avgY = (totalY / totalMass) * (height / 36);

                        detectedX = avgX;
                        detectedY = avgY;
                        lastMotionTimeRef.current = Date.now();

                        // Calculate action characteristics once (used for both positioning and click detection)
                        const widthChange = maxX - minX;
                        const heightChange = maxY - minY;
                        const changeArea = widthChange * heightChange;
                        // Click detection - balanced to detect real clicks but not hover effects
                        // Real clicks cause sudden, localized pixel changes in a focused area
                        const isCompact = widthChange < 18 && heightChange < 10; // Balanced bounds
                        const hasVerticalScroll = heightChange > MOTION_CONFIG.SCROLL_HEIGHT_THRESHOLD;
                        const hasWideArea = changeArea > MOTION_CONFIG.LOCALIZED_ACTION_AREA;
                        const isScrolling = hasVerticalScroll && hasWideArea;
                        
                        // Click detection: balanced for real clicks
                        // - Must have sufficient mass (ZOOM_MIN_MASS) to be a real click
                        // - Must be compact (not spread across screen like hover effects)
                        // - Must not be too large (filtering out animations)
                        const isClickAction = changeArea < MOTION_CONFIG.LOCALIZED_ACTION_AREA && 
                                             totalMass >= MOTION_CONFIG.ZOOM_MIN_MASS &&
                                             totalMass < 60 && // Upper bound to reject large animations
                                             isCompact && !isScrolling;

                        // Follow-cursor logic: When zoom is active, continuously track cursor position
                        // Responsive tracking when zoomed in, smoother when zoomed out
                        if (zoomEnabledRef.current && rigRef.current.get_view_rect) {
                            const view = rigRef.current.get_view_rect();
                            const currentZoom = view.zoom || 1.0;
                            
                            // Click action: Snap quickly to clicked component
                            if (isClickAction) {
                                const clickSmoothing = MOTION_CONFIG.TARGET_SMOOTHING_CLICK;
                                currentTargetRef.current.x = currentTargetRef.current.x + 
                                    (detectedX - currentTargetRef.current.x) * clickSmoothing;
                                currentTargetRef.current.y = currentTargetRef.current.y + 
                                    (detectedY - currentTargetRef.current.y) * clickSmoothing;
                            } else if (currentZoom > MOTION_CONFIG.ZOOM_OUT_LEVEL + 0.1) {
                                // Zoomed in: Follow cursor responsively
                                const smoothing = MOTION_CONFIG.TARGET_SMOOTHING;
                                currentTargetRef.current.x = currentTargetRef.current.x + 
                                    (detectedX - currentTargetRef.current.x) * smoothing;
                                currentTargetRef.current.y = currentTargetRef.current.y + 
                                    (detectedY - currentTargetRef.current.y) * smoothing;
                            }
                            // When zoomed out, don't update target (camera stays centered)
                        } else {
                            // When zoom is not active yet - prepare for potential zoom
                            if (isClickAction) {
                                // Pre-position on clicks before zoom activates
                                // Slightly slower than active zoom (80%) for smoother transition when zoom kicks in
                                const clickSmoothing = MOTION_CONFIG.TARGET_SMOOTHING_CLICK * 0.8;
                                currentTargetRef.current.x = currentTargetRef.current.x + 
                                    (detectedX - currentTargetRef.current.x) * clickSmoothing;
                                currentTargetRef.current.y = currentTargetRef.current.y + 
                                    (detectedY - currentTargetRef.current.y) * clickSmoothing;
                            }
                            // Don't track cursor movement when zoom is not active
                        }

                        // Update history
                        prevDetectedTargetRef.current.x = detectedX;
                        prevDetectedTargetRef.current.y = detectedY;
                        
                        // Mouse motion overrides typing mode temporarily
                        // If user moves mouse significantly while typing, prioritize mouse position
                        if (isTypingModeRef.current && totalMass > MOTION_CONFIG.MOUSE_OVERRIDE_THRESHOLD) {
                            // Only override if it's significant mouse motion
                            isTypingModeRef.current = false;
                            typingTargetRef.current = null;
                        }

                        // Click tracking: Window-based zoom trigger
                        // - First click opens a 3-second window
                        // - Second click within window enables zoom
                        // - Window closes after 3 seconds, next click starts fresh window
                        if (isClickAction) {
                            const now = Date.now();
                            
                            if (clickTimestampsRef.current.length === 0) {
                                // No active window - this click opens a new window
                                clickTimestampsRef.current = [now];
                            } else {
                                const firstClickTime = clickTimestampsRef.current[0];
                                if (now - firstClickTime < MOTION_CONFIG.CLICK_WINDOW_MS) {
                                    // Still within active window - add this click
                                    clickTimestampsRef.current.push(now);
                                    
                                    // Enable zoom once we reach MIN_CLICKS_TO_ZOOM within window
                                    if (clickTimestampsRef.current.length >= MOTION_CONFIG.MIN_CLICKS_TO_ZOOM) {
                                        zoomEnabledRef.current = true;
                                    }
                                } else {
                                    // Window expired - start completely fresh window
                                    // This click is the first click of a new window
                                    clickTimestampsRef.current = [now];
                                    // Reset zoom - user needs to click twice again to enable
                                    zoomEnabledRef.current = false;
                                }
                            }
                        }

                        // Smart Autozoom with clear priority:
                        // PRIORITY 1: Scrolling ALWAYS zooms OUT (most important for navigation)
                        // PRIORITY 2: Click actions zoom IN - requires 2+ clicks within 3s window
                        // PRIORITY 3: Typing also zooms IN (handled separately in typing mode)
                        // PRIORITY 4: Light motion maintains current zoom (for cursor movement)

                        // WARMUP: Force zoom out for first 1.5s to prevent startup jumps
                        // Do NOT allow zoom during warmup period regardless of clicks
                        if (warmupFramesRef.current < 90) {
                             rigRef.current.set_target_zoom(MOTION_CONFIG.ZOOM_OUT_LEVEL);
                             // Don't enable zoom during warmup
                             zoomEnabledRef.current = false;
                        } else {
                            if (isScrolling) {
                                // Scrolling detected - ALWAYS zoom OUT to overview for context
                                // This takes absolute priority over everything else
                                rigRef.current.set_target_zoom(MOTION_CONFIG.ZOOM_OUT_LEVEL);
                                // Reset zoom enablement on scroll
                                zoomEnabledRef.current = false;
                                clickTimestampsRef.current = [];
                            } else if (zoomEnabledRef.current) {
                                // KEEP zoomed in as long as zoom is enabled
                                // This prevents the shaky zoom out/in when clicking between components
                                // Zoom will only go out when window expires or scroll is detected
                                rigRef.current.set_target_zoom(MOTION_CONFIG.ZOOM_IN_LEVEL);
                            }
                        }
                        // For light motion (panning, slight hover), maintain current zoom level
                    }
                } else if (motionContextRef.current) {
                    // First frame init
                    motionContextRef.current.drawImage(video, 0, 0, 64, 36);
                    const data = motionContextRef.current.getImageData(0, 0, 64, 36).data;
                    prevFrameDataRef.current = new Uint8ClampedArray(data);
                }

                const timeSinceMotion = Date.now() - lastMotionTimeRef.current;
                const timeSinceTyping = Date.now() - lastKeyTimeRef.current;

                // Check if we're in typing mode (typing within last 2 seconds)
                if (timeSinceTyping < 2000 && isTypingModeRef.current && typingTargetRef.current) {
                    // Typing mode - zoom in and follow the caret
                    rigRef.current.set_target_zoom(MOTION_CONFIG.ZOOM_IN_LEVEL);
                    
                    // Update target to caret position with smooth lerp
                    const lerpFactor = MOTION_CONFIG.TARGET_SMOOTHING;
                    currentTargetRef.current.x = currentTargetRef.current.x + 
                        (typingTargetRef.current.x - currentTargetRef.current.x) * lerpFactor;
                    currentTargetRef.current.y = currentTargetRef.current.y + 
                        (typingTargetRef.current.y - currentTargetRef.current.y) * lerpFactor;
                } else if (timeSinceTyping >= 2000 && isTypingModeRef.current) {
                    // Exit typing mode after 2 seconds of inactivity
                    isTypingModeRef.current = false;
                    typingTargetRef.current = null;
                }

                // Check if we're still within an active click window
                const now = Date.now();
                const firstClickTime = clickTimestampsRef.current.length > 0 ? clickTimestampsRef.current[0] : 0;
                const hasActiveClickWindow = clickTimestampsRef.current.length > 0 && 
                    (now - firstClickTime < MOTION_CONFIG.CLICK_WINDOW_MS);
                
                // If window expired, reset zoom state
                // This ensures zoom out happens when user stops clicking for 3 seconds
                if (!hasActiveClickWindow && clickTimestampsRef.current.length > 0) {
                    clickTimestampsRef.current = [];
                    zoomEnabledRef.current = false;
                }

                // Zoom out after 2 seconds of no motion/clicks AND not typing AND no active click window
                // This prevents zoom out when user is actively clicking within the zoom window
                if (timeSinceMotion > 2000 && !isTypingModeRef.current && !hasActiveClickWindow && !zoomEnabledRef.current) {
                    rigRef.current.set_target_zoom(MOTION_CONFIG.ZOOM_OUT_LEVEL);
                }

                // Use Motion Target for Physics
                const targetX = currentTargetRef.current.x;
                const targetY = currentTargetRef.current.y;

                // Optimize physics during warmup - use lower frame rate since camera isn't moving
                if (isWarmupPeriod) {
                    // During warmup, update physics at lower rate (30fps instead of 60fps)
                    // This reduces CPU load when encoder is starting up
                    if (physicsFrameCount % 2 === 0) {
                        rigRef.current.update(targetX, targetY, 1 / 30);
                    }
                } else {
                    // After warmup: Update Physics at 60fps for buttery smooth camera movement
                    rigRef.current.update(targetX, targetY, 1 / 60);
                }
                const view = rigRef.current.get_view_rect();
                
                // Track zoom events for the editor
                // Detect when we transition into/out of zoomed state
                const isZoomedIn = view.zoom > 1.1; // Consider zoomed if > 1.1
                const wasZoomedIn = currentZoomEventRef.current !== null;
                
                if (isZoomedIn && !wasZoomedIn) {
                    // Started zooming - record start time and position
                    const elapsedMs = startTimeRef.current > 0 ? performance.now() - startTimeRef.current : 0;
                    currentZoomEventRef.current = {
                        startTime: elapsedMs,
                        x: currentTargetRef.current.x / width, // Normalize to 0-1
                        y: currentTargetRef.current.y / height
                    };
                } else if (!isZoomedIn && wasZoomedIn && currentZoomEventRef.current) {
                    // Stopped zooming - record the complete zoom event
                    const elapsedMs = startTimeRef.current > 0 ? performance.now() - startTimeRef.current : 0;
                    const zoomEvent = {
                        id: Math.random().toString(36).substr(2, 9),
                        timestamp: currentZoomEventRef.current.startTime,
                        duration: Math.max(500, elapsedMs - currentZoomEventRef.current.startTime), // Min 500ms
                        zoomLevel: MOTION_CONFIG.ZOOM_IN_LEVEL,
                        cursorPosition: {
                            x: currentZoomEventRef.current.x,
                            y: currentZoomEventRef.current.y
                        }
                    };
                    zoomEventsRef.current.push(zoomEvent);
                    currentZoomEventRef.current = null;
                }
                
                physicsFrameCount++;

                if (frameCountRef.current % 120 === 0) {
                    console.log("📹 View:", view);
                }

                // Config Canvas
                canvasRef.current.width = width;
                canvasRef.current.height = height;

                // 1. Fill Background
                const bg = backgroundRef.current;
                if (bg.type === 'solid') {
                    ctx.fillStyle = bg.color;
                    ctx.fillRect(0, 0, width, height);
                } else if (bg.type === 'gradient' && bg.startColor && bg.endColor) {
                    const gradient = ctx.createLinearGradient(0, 0, width, height); // Diagonal-ish or horizontal?
                    // vzoneui uses 'to right' which is 0,0 -> width,0
                    gradient.addColorStop(0, bg.startColor);
                    gradient.addColorStop(1, bg.endColor);
                    ctx.fillStyle = gradient;
                    ctx.fillRect(0, 0, width, height);
                }

                // 2. Draw Video Frame (Centered Transform)
                ctx.save();
                ctx.translate(width / 2, height / 2); // Center of canvas
                ctx.scale(view.zoom, view.zoom);
                ctx.translate(-view.x, -view.y); // Move focus point to center
                ctx.drawImage(video, 0, 0, width, height); // Explicitly set video dimensions
                ctx.restore();

                // Use REAL ELAPSED TIME - muxer uses milliseconds timescale
                if (startTimeRef.current === 0) {
                    startTimeRef.current = performance.now();
                    console.log("🎬 Recording started at:", startTimeRef.current);
                }
                const elapsedMs = performance.now() - startTimeRef.current;
                // Muxer uses timescale=1000 (ms), so pass timestamp in ms
                const timestamp = Math.round(elapsedMs * 1000); // microseconds for VideoFrame

                // Diagnostic logging - EVERY 30 frames to see if loop is running
                if (frameCountRef.current % 30 === 0) {
                    const expected = (frameCountRef.current / 30 * 1000);
                    console.log(`🎞️ Frame ${frameCountRef.current}: ${elapsedMs.toFixed(0)}ms elapsed, expected ~${expected.toFixed(0)}ms @ 30fps`);
                }

                // Only encode every other physics frame (30fps encoding from 60fps physics)
                // This keeps camera movement smooth while maintaining efficient encoding
                const shouldEncode = physicsFrameCount % 2 === 0;
                
                // Only encode if we're still actively recording, encoder is ready, and video track is active
                if (displayMedia && shouldEncode) {
                    const videoTrack = displayMedia.getVideoTracks()[0];
                    if (isProcessorActiveRef.current && 
                        encoder.state === "configured" && 
                        videoTrack && 
                        videoTrack.readyState === 'live') {
                        try {
                            // Adaptive queue management for smooth startup and sustained performance
                            // More lenient at startup (first 60 frames), then stricter for steady state
                            const isStartup = frameCountRef.current < 60;
                            const queueLimit = isStartup ? 15 : 8;
                            
                            // Check encoder queue size to prevent overflow on animated content
                            if (encoder.encodeQueueSize < queueLimit) {
                                const frame = new VideoFrame(canvasRef.current!, { timestamp });
                                encoder.encode(frame, { keyFrame: frameCountRef.current % 30 === 0 });
                                frame.close();
                            } else {
                                // Queue is backing up - skip frame to let encoder catch up
                                if (frameCountRef.current % 60 === 0) {
                                    console.warn(`⚠️ Encoder queue: ${encoder.encodeQueueSize}/${queueLimit}, skipping frame`);
                                }
                            }
                        } catch (e) {
                             console.error("Frame encoding error:", e);
                             // Stop on encoding error to prevent cascade
                             isProcessorActiveRef.current = false;
                        }
                    } else if (videoTrack && videoTrack.readyState !== 'live') {
                        console.warn("Video track no longer live, stopping frame generation");
                        isProcessorActiveRef.current = false;
                    }
                }

                frameCountRef.current++;
                // Log every 30 frames to confirm loop is running  
                if (frameCountRef.current % 30 === 0) {
                    console.log(`✅ Loop alive - frame ${frameCountRef.current}`);
                }
            };

            video.onloadedmetadata = () => {
                console.log("📺 Video loaded, starting Worker loop at 60fps for smooth camera...");

                // Activate Processor
                isProcessorActiveRef.current = true;
                setIsRecording(true);

                // Set up worker message handler to drive the loop
                if (workerRef.current) {
                    workerRef.current.onmessage = (e) => {
                        if (e.data === 'tick') {
                            try {
                                draw();
                            } catch (err) {
                                console.error("❌ draw() error:", err);
                                // Don't recurse stopRecording in critical path, just log
                            }
                        }
                    };
                    // Start the worker timer at 60fps for smooth camera physics
                    // (We'll encode at 30fps by skipping every other frame)
                    workerRef.current.postMessage({ type: 'start', fps: 60 });
                    console.log("🚀 Worker loop started at 60fps for buttery smooth zoom and pan");
                }
            };

            // Stop handler - when track ends (user clicks "Stop Sharing")
            track.onended = () => {
                console.log("📹 Video track ended - stopping recording");
                // Don't set isProcessorActiveRef here - let stopRecording handle it
                // Otherwise stopRecording's early return will skip cleanup!
                stopRecording();
            };

        } catch (err) {
            console.error("Error starting recording:", err);
            // Critical: If we failed to start (e.g. Muxer crash), ensure we cleanup the stream
            // otherwise user gets red dot but no recording app logic.
            if (displayMedia) {
                displayMedia.getTracks().forEach(t => t.stop());
            }
            setStream(null);
            setIsRecording(false);
            alert("Failed to start recording core. Please check permissions or refresh.");
        }
    }, [stopRecording, quality]);

    // DELETED OLD stopRecording LOCATION

    return {
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
    };
};
