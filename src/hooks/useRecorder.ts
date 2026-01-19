import type { BackgroundConfig } from '../types';
import { useState, useRef, useEffect, useCallback } from 'react';
import init, { CameraRig, Mp4Muxer } from '../../recorder_core/pkg/recorder_core';

// Motion detection and zoom constants
const MOTION_THRESHOLD = 10; // Lower = more sensitive
const MIN_MOTION_MASS = 3; // Minimum for click detection
const MOTION_SMOOTHING = 0.3; // Target tracking smoothing factor
const MAX_RGB_VALUE = 255; // Maximum RGB color value
const IDLE_TIMEOUT_MS = 1500; // Time before zoom out
const CENTER_DRIFT_FACTOR = 0.02; // Gentle center drift speed

// Zoom level constants
const ZOOM_MINOR_MOTION = 1.5; // Zoom for clicks/small movements
const ZOOM_MAJOR_MOTION = 2.2; // Max zoom for typing/large movements
const ZOOM_INTENSITY_SCALE = 1.5; // Multiplier for motion-based zoom
const ZOOM_INTENSITY_DIVISOR = 100; // Divisor for motion mass calculation
const MOTION_MASS_MINOR_THRESHOLD = 2; // Threshold for minor motion
const MOTION_MASS_MAJOR_THRESHOLD = 5; // Threshold for major motion

export const useRecorder = () => {
    const [isRecording, setIsRecording] = useState(false);
    const [isReady, setIsReady] = useState(false);
    const [stream, setStream] = useState<MediaStream | null>(null);
    const [previewBlobUrl, setPreviewBlobUrl] = useState<string | null>(null);

    const canvasRef = useRef<HTMLCanvasElement>(null);
    const requestRef = useRef<number>(0);
    const muxerRef = useRef<Mp4Muxer | null>(null);
    const rigRef = useRef<CameraRig | null>(null);
    const videoEncoderRef = useRef<VideoEncoder | null>(null);
    const frameCountRef = useRef(0);
    const startTimeRef = useRef<number>(0);
    const videoDimensionsRef = useRef({ width: 1920, height: 1080 }); // Store video dimensions

    // Background State
    const [backgroundConfig, setBackgroundConfig] = useState<BackgroundConfig>({ type: 'solid', color: '#171717' });
    const backgroundRef = useRef<BackgroundConfig>({ type: 'solid', color: '#171717' });

    const motionCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const motionContextRef = useRef<CanvasRenderingContext2D | null>(null);
    const prevFrameDataRef = useRef<Uint8ClampedArray | null>(null);
    const lastMotionTimeRef = useRef<number>(0);
    const currentTargetRef = useRef({ x: 960, y: 540 }); // Smooth target tracking
    const workerRef = useRef<Worker | null>(null);

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

    const setBackground = useCallback((config: BackgroundConfig) => {
        setBackgroundConfig(config);
        backgroundRef.current = config;
    }, []);

    const stopRecording = useCallback(async () => {
        try {
            // Stop Worker Loop
            workerRef.current?.postMessage('stop');

            // Clear any lingering interval if it exists (though we use worker now)
            if (requestRef.current) {
                clearInterval(requestRef.current);
                requestRef.current = 0;
            }
            setIsRecording(false);

            // Bring focus back to this window
            window.focus();

            if (videoEncoderRef.current && videoEncoderRef.current.state !== 'closed') {
                try {
                    await videoEncoderRef.current.flush();
                } catch (e) {
                    console.error("Encoder flush warning:", e);
                }
                videoEncoderRef.current.close();
            }

            if (stream) {
                stream.getTracks().forEach(t => t.stop());
                setStream(null);
            }

            if (muxerRef.current) {
                try {
                    const bytes = muxerRef.current.finish();
                    console.log("Muxer finished. Total bytes:", bytes.length);

                    if (bytes.length < 1000) {
                        console.warn("⚠️ Warning: Video file is surprisingly small (<1KB). Recording might have failed.");
                        alert("Warning: Recording seems empty. Please check permissions / console.");
                    }

                    // Use video/mp4 for correct format detection
                    const blob = new Blob([bytes as unknown as BlobPart], { type: 'video/mp4' });
                    const url = URL.createObjectURL(blob);
                    console.log("Setting preview URL:", url);
                    setPreviewBlobUrl(url);
                } catch (e) {
                    console.error("Muxer finish failed:", e);
                    alert("Muxer Error on Finish: " + e);
                }
                muxerRef.current = null;
            } else {
                console.warn("Muxer was null in stopRecording! No video data.");
                alert("No video data was recorded. (Muxer not initialized - did recording start?)");
            }
        } catch (err) {
            console.error("Critical error in stopRecording:", err);
            setIsRecording(false);
        }
    }, [stream]);

    const startRecording = useCallback(async () => {
        let displayMedia: MediaStream | null = null;
        try {
            displayMedia = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    width: { ideal: 1920 },
                    height: { ideal: 1080 },
                    frameRate: 60,
                },
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    sampleRate: 44100
                }
            });

            setStream(displayMedia);
            setPreviewBlobUrl(null);
            lastMotionTimeRef.current = Date.now();

            const track = displayMedia.getVideoTracks()[0];
            const settings = track.getSettings();
            const width = settings.width || 1920;
            const height = settings.height || 1080;
            
            // Store dimensions for use in draw function
            videoDimensionsRef.current = { width, height };

            // Initialize Camera Rig
            rigRef.current = new CameraRig(width, height);

            // Initialize VideoEncoder
            const encoder = new VideoEncoder({
                output: (chunk, metadata) => {
                    // Lazy init Muxer once we have the codec config (SPS/PPS)
                    if (!muxerRef.current && metadata?.decoderConfig?.description) {
                        const description = new Uint8Array(metadata.decoderConfig.description as ArrayBuffer);
                        console.log("Initializing Muxer with AVCC config, length:", description.length);
                        try {
                            muxerRef.current = new Mp4Muxer(1920, 1080, description);
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
                error: (e) => console.error(e),
            });

            encoder.configure({
                // Level 4.2 (supports 1080p @ 60fps)
                // Profile: Baseline (42) or Main (4d) or High (64). 
                // Let's use Constrained Baseline (42002a) for max compatibility but higher level.
                codec: 'avc1.42002a',
                width: 1920,
                height: 1080,
                bitrate: 6_000_000, // 6 Mbps
                framerate: 60,
            });
            videoEncoderRef.current = encoder;

            // Setup Render Loop
            const video = document.createElement('video');
            video.srcObject = displayMedia;
            video.muted = true; // Important for autoplay
            video.play();

            const draw = () => {
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
                    let maxIntensity = 0;

                    for (let i = 0; i < frameData.length; i += 4) {
                        // Weighted luminosity calculation for better accuracy
                        const rDiff = Math.abs(frameData[i] - prevData[i]);
                        const gDiff = Math.abs(frameData[i + 1] - prevData[i + 1]);
                        const bDiff = Math.abs(frameData[i + 2] - prevData[i + 2]);
                        const diff = rDiff + gDiff + bDiff;

                        // Check if pixel changed significantly
                        if (diff > MOTION_THRESHOLD) {
                            const pixelIdx = i / 4;
                            const x = pixelIdx % 64;
                            const y = Math.floor(pixelIdx / 64);

                            // Weight by intensity for more accurate centroid
                            const weight = diff / MAX_RGB_VALUE;
                            totalX += x * weight;
                            totalY += y * weight;
                            totalMass += weight;
                            maxIntensity = Math.max(maxIntensity, diff);
                        }
                    }

                    // Save current frame for next loop
                    prevFrameDataRef.current.set(frameData);

                    // If enough motion detected, update target
                    if (totalMass > MIN_MOTION_MASS) {
                        // Scale back up to source dimensions
                        const { width, height } = videoDimensionsRef.current;
                        const avgX = (totalX / totalMass) * (width / 64);
                        const avgY = (totalY / totalMass) * (height / 36);

                        detectedX = avgX;
                        detectedY = avgY;
                        lastMotionTimeRef.current = Date.now();

                        // Smooth tracking with momentum
                        currentTargetRef.current.x += (detectedX - currentTargetRef.current.x) * MOTION_SMOOTHING;
                        currentTargetRef.current.y += (detectedY - currentTargetRef.current.y) * MOTION_SMOOTHING;
                    }

                    // Adaptive zoom based on motion intensity
                    // More motion = more zoom for better focus
                    if (totalMass > MOTION_MASS_MAJOR_THRESHOLD) {
                        // Gradual zoom in based on activity level
                        const zoomLevel = Math.min(ZOOM_MAJOR_MOTION, 1.0 + (totalMass / ZOOM_INTENSITY_DIVISOR) * ZOOM_INTENSITY_SCALE);
                        rigRef.current.set_target_zoom(zoomLevel);
                    } else if (totalMass > MOTION_MASS_MINOR_THRESHOLD) {
                        // Slight zoom for small movements (clicks, cursor)
                        rigRef.current.set_target_zoom(ZOOM_MINOR_MOTION);
                    }
                } else if (motionContextRef.current) {
                    // First frame init
                    motionContextRef.current.drawImage(video, 0, 0, 64, 36);
                    const data = motionContextRef.current.getImageData(0, 0, 64, 36).data;
                    prevFrameDataRef.current = new Uint8ClampedArray(data);
                }

                const timeSinceMotion = Date.now() - lastMotionTimeRef.current;

                if (timeSinceMotion > IDLE_TIMEOUT_MS) {
                    // Smooth zoom out
                    rigRef.current.set_target_zoom(1.0);
                    // Gentle drift back to center
                    const { width, height } = videoDimensionsRef.current;
                    const centerX = width / 2;
                    const centerY = height / 2;
                    currentTargetRef.current.x += (centerX - currentTargetRef.current.x) * CENTER_DRIFT_FACTOR;
                    currentTargetRef.current.y += (centerY - currentTargetRef.current.y) * CENTER_DRIFT_FACTOR;
                }

                // Use Motion Target for Physics
                const targetX = currentTargetRef.current.x;
                const targetY = currentTargetRef.current.y;

                // Update Physics
                rigRef.current.update(targetX, targetY, 1 / 60);
                const view = rigRef.current.get_view_rect();

                if (frameCountRef.current % 120 === 0) {
                    console.log("📹 View:", view);
                }

                // Config Canvas
                canvasRef.current.width = 1920;
                canvasRef.current.height = 1080;

                // 1. Fill Background
                const bg = backgroundRef.current;
                if (bg.type === 'solid') {
                    ctx.fillStyle = bg.color;
                    ctx.fillRect(0, 0, 1920, 1080);
                } else if (bg.type === 'gradient' && bg.startColor && bg.endColor) {
                    const gradient = ctx.createLinearGradient(0, 0, 1920, 1080); // Diagonal-ish or horizontal?
                    // vzoneui uses 'to right' which is 0,0 -> 1920,0
                    gradient.addColorStop(0, bg.startColor);
                    gradient.addColorStop(1, bg.endColor);
                    ctx.fillStyle = gradient;
                    ctx.fillRect(0, 0, 1920, 1080);
                }

                // 2. Draw Video Frame (Centered Transform)
                ctx.save();
                ctx.translate(960, 540); // Center of canvas
                ctx.scale(view.zoom, view.zoom);
                ctx.translate(-view.x, -view.y); // Move focus point to center
                ctx.drawImage(video, 0, 0);
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
                    const expected = (frameCountRef.current / 60 * 1000);
                    console.log(`🎞️ Frame ${frameCountRef.current}: ${elapsedMs.toFixed(0)}ms elapsed, expected ~${expected.toFixed(0)}ms @ 60fps`);
                }

                const frame = new VideoFrame(canvasRef.current, { timestamp });
                encoder.encode(frame, { keyFrame: frameCountRef.current % 60 === 0 });
                frame.close();

                frameCountRef.current++;
                // Log every 30 frames to confirm loop is running  
                if (frameCountRef.current % 30 === 0) {
                    console.log(`✅ Loop alive - frame ${frameCountRef.current}`);
                }
            };

            video.onloadedmetadata = () => {
                console.log("📺 Video loaded, starting Worker loop...");

                // Set up worker message handler to drive the loop
                if (workerRef.current) {
                    workerRef.current.onmessage = (e) => {
                        if (e.data === 'tick') {
                            try {
                                draw();
                            } catch (err) {
                                console.error("❌ draw() error:", err);
                                stopRecording();
                            }
                        }
                    };
                    // Start the worker timer
                    workerRef.current.postMessage('start');
                    console.log("🚀 Worker loop started");
                }
            };

            setIsRecording(true);

            // Stop handler
            track.onended = () => {
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
    }, [stopRecording]);

    // DELETED OLD stopRecording LOCATION

    return {
        isRecording,
        isReady,
        startRecording,
        stopRecording,
        canvasRef,
        previewBlobUrl,
        setBackground,
        backgroundConfig
    };
};
