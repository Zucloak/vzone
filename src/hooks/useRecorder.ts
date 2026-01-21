import type { BackgroundConfig, VideoQuality, DeviceCapability } from '../types';
import { useState, useRef, useEffect, useCallback } from 'react';
import init, { CameraRig, Mp4Muxer } from '../../recorder_core/pkg/recorder_core';
import { getCaretCoordinates, isTypingActive, isIgnoredKey } from '../utils/caretTracking';

// Motion detection configuration (tuned for 64x36 analysis buffer)
const MOTION_CONFIG = {
    // Pixel change detection
    THRESHOLD: 10,              // RGB diff threshold (lower = more sensitive)
    MIN_MASS: 2,                // Minimum changed pixels to register motion
    
    // Scroll detection (dimensions in analysis buffer coordinate space)
    SCROLL_HEIGHT_THRESHOLD: 5,  // Height change indicating scroll (out of 36 pixels) - very lenient for reliable detection
    SCROLL_WIDTH_THRESHOLD: 40,  // Width change indicating scroll (out of 64 pixels)
    LOCALIZED_ACTION_AREA: 150,  // Max area for click/type actions (pixels²) - tight for precise detection
    
    // Zoom triggers
    ZOOM_MIN_MASS: 2,           // Minimum mass to trigger zoom - ultra sensitive for immediate click detection
    ZOOM_MAX_VELOCITY: 80,      // Max velocity for zoom-in (pixels/frame)
    ZOOM_OUT_VELOCITY: 100,     // Velocity threshold for zoom-out
    MOUSE_OVERRIDE_THRESHOLD: 2, // Minimum motion to override typing mode
    
    // Click tracking (Cursorful-style multi-click trigger)
    CLICK_WINDOW_MS: 3000,      // Time window for click tracking (3 seconds)
    MIN_CLICKS_TO_ZOOM: 2,      // Minimum clicks required to trigger zoom
    
    // Smoothing
    TARGET_SMOOTHING: 0.4,      // Lerp factor for target position (0.4 = very responsive)
    TARGET_SMOOTHING_CLICK: 1.0, // No smoothing on clicks (instant snap)
    
    // Zoom levels
    ZOOM_IN_LEVEL: 1.8,         // Zoom level for focused actions (clicks, typing)
    ZOOM_OUT_LEVEL: 1.0,        // Zoom level for overview (scrolling, idle)
} as const;

// Encoder timing constants
const ENCODER_SETTLE_DELAY_MS = 300; // Delay to allow pending frames to complete encoding

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

            // Give time for any pending frame encoding to complete
            // This prevents race conditions where frames are still being encoded
            // when we try to flush/close the encoder
            console.log(`⏳ Waiting ${ENCODER_SETTLE_DELAY_MS}ms for in-flight frames to complete...`);
            await new Promise(resolve => setTimeout(resolve, ENCODER_SETTLE_DELAY_MS));

            // Flush and Close Encoder with improved error handling
            // CRITICAL: Keep canvas and stream alive until encoder is fully closed
            if (videoEncoderRef.current) {
                try {
                    const encoderState = videoEncoderRef.current.state;
                    console.log("Encoder state before flush:", encoderState);
                    
                    if (encoderState === 'configured') {
                        await videoEncoderRef.current.flush();
                        console.log("Encoder flushed successfully");
                    }
                    
                    // Check state again after flush
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
            lastMotionTimeRef.current = Date.now();

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
                    // Only process output if we're still actively recording
                    if (!isProcessorActiveRef.current) return;
                    
                    // Lazy init Muxer once we have the codec config (SPS/PPS)
                    if (!muxerRef.current && metadata?.decoderConfig?.description) {
                        const description = new Uint8Array(metadata.decoderConfig.description as ArrayBuffer);
                        console.log("Initializing Muxer with AVCC config, length:", description.length);
                        try {
                            muxerRef.current = new Mp4Muxer(width, height, description);
                        } catch (e) {
                            console.error("Failed to create Muxer:", e);
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
                        console.error("VideoEncoder error:", e);
                    } else {
                        console.log("VideoEncoder error during shutdown (expected):", e.message);
                    }
                    // Stop processing immediately on encoder error to prevent cascade failures
                    isProcessorActiveRef.current = false;
                    workerRef.current?.postMessage('stop');
                },
            });

            // Configure encoder with settings optimized for performance and quality balance
            // High Profile Level 4.0 (640028) supports 1080p resolution
            // Hardware acceleration required to offload encoding to GPU for smooth recording

            // Bitrate selection based on quality
            let targetBitrate = 8_000_000; // Default Highest
            if (quality === 'high') targetBitrate = 4_000_000;
            if (quality === 'low') targetBitrate = 2_000_000;

            console.log(`⚙️ Configuring Encoder: Quality=${quality}, Bitrate=${targetBitrate/1000000}Mbps`);

            encoder.configure({
                codec: 'avc1.640028', // High Profile, Level 4.0 - supports 1080p with better compression
                width: width,
                height: height,
                bitrate: targetBitrate,
                framerate: 30, // 30fps for smooth recording without laggy performance
                hardwareAcceleration: 'prefer-hardware', // Prefer hardware encoding for better performance
                latencyMode: 'realtime', // Realtime mode for responsive encoding
            });
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

                if (motionContextRef.current && prevFrameDataRef.current) {
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
                        const isCompact = widthChange < 20 && heightChange < 10;
                        const isVerticalMove = heightChange > widthChange * 1.5;
                        const hasVerticalScroll = heightChange > MOTION_CONFIG.SCROLL_HEIGHT_THRESHOLD;
                        const hasWideArea = changeArea > MOTION_CONFIG.LOCALIZED_ACTION_AREA;
                        const isScrolling = hasVerticalScroll && hasWideArea;
                        
                        const isClickAction = changeArea < MOTION_CONFIG.LOCALIZED_ACTION_AREA && 
                                             totalMass > MOTION_CONFIG.ZOOM_MIN_MASS &&
                                             isCompact && !isVerticalMove && !isScrolling;

                        // Follow-cursor logic: When zoom is active, continuously track cursor position
                        // Use instant positioning on clicks, smooth tracking for cursor movement
                        if (zoomEnabledRef.current && rigRef.current.get_view_rect) {
                            const view = rigRef.current.get_view_rect();
                            const currentZoom = view.zoom || 1.0;
                            
                            // Instant snap to position on click actions for immediate response
                            if (isClickAction) {
                                // No lerp - instant positioning on clicks
                                currentTargetRef.current.x = detectedX;
                                currentTargetRef.current.y = detectedY;
                            } else if (currentZoom > MOTION_CONFIG.ZOOM_OUT_LEVEL + 0.1) {
                                // Apply high smoothing for responsive cursor following when zoomed
                                const smoothing = MOTION_CONFIG.TARGET_SMOOTHING;
                                currentTargetRef.current.x = currentTargetRef.current.x + 
                                    (detectedX - currentTargetRef.current.x) * smoothing;
                                currentTargetRef.current.y = currentTargetRef.current.y + 
                                    (detectedY - currentTargetRef.current.y) * smoothing;
                            } else {
                                // When zoomed out, use moderate smoothing
                                const smoothing = MOTION_CONFIG.TARGET_SMOOTHING * 0.6;
                                currentTargetRef.current.x = currentTargetRef.current.x + 
                                    (detectedX - currentTargetRef.current.x) * smoothing;
                                currentTargetRef.current.y = currentTargetRef.current.y + 
                                    (detectedY - currentTargetRef.current.y) * smoothing;
                            }
                        } else {
                            // When zoom is not active yet
                            if (isClickAction) {
                                // Instant snap on clicks even before zoom is fully active
                                // This pre-positions the camera for when zoom activates
                                currentTargetRef.current.x = detectedX;
                                currentTargetRef.current.y = detectedY;
                            } else {
                                // Use lighter smoothing for non-click movement
                                const smoothing = MOTION_CONFIG.TARGET_SMOOTHING * 0.3;
                                currentTargetRef.current.x = currentTargetRef.current.x + 
                                    (detectedX - currentTargetRef.current.x) * smoothing;
                                currentTargetRef.current.y = currentTargetRef.current.y + 
                                    (detectedY - currentTargetRef.current.y) * smoothing;
                            }
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

                        // Click tracking: Add timestamp when a localized action is detected
                        // (isClickAction is the same as isLocalizedAction)
                        if (isClickAction) {
                            const now = Date.now();
                            clickTimestampsRef.current.push(now);
                            
                            // Remove old clicks outside the time window
                            clickTimestampsRef.current = clickTimestampsRef.current.filter(
                                timestamp => now - timestamp < MOTION_CONFIG.CLICK_WINDOW_MS
                            );
                            
                            // Enable zoom if we have 2+ clicks within the window
                            if (clickTimestampsRef.current.length >= MOTION_CONFIG.MIN_CLICKS_TO_ZOOM) {
                                zoomEnabledRef.current = true;
                            }
                        }

                        // Smart Autozoom with clear priority:
                        // PRIORITY 1: Scrolling ALWAYS zooms OUT (most important for navigation)
                        // PRIORITY 2: Localized clicks/typing zoom IN (for focused actions) - ONLY if zoom enabled
                        // PRIORITY 3: Light motion maintains current zoom (for cursor movement)

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
                            } else if (isClickAction && zoomEnabledRef.current) {
                                // Focused action detected (click, type) - zoom in
                                // Only triggers if NOT scrolling AND zoom is enabled
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
                    // PRIORITY: Typing mode - zoom in and follow the caret
                    // Override motion detection to focus on text input
                    rigRef.current.set_target_zoom(MOTION_CONFIG.ZOOM_IN_LEVEL);
                    
                    // Update target to caret position with smooth lerp
                    // Use same smoothing factor as motion detection for consistency
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

                if (timeSinceMotion > 2000 && !isTypingModeRef.current) { // 2s idle and not typing
                    // Zoom OUT only if not in typing mode
                    rigRef.current.set_target_zoom(MOTION_CONFIG.ZOOM_OUT_LEVEL);
                }

                // Use Motion Target for Physics
                const targetX = currentTargetRef.current.x;
                const targetY = currentTargetRef.current.y;

                // Update Physics at 60fps for buttery smooth camera movement
                // Even though we encode at 30fps, smooth physics makes the experience feel responsive
                rigRef.current.update(targetX, targetY, 1 / 60);
                const view = rigRef.current.get_view_rect();
                
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
        deviceCapability
    };
};
