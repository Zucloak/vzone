import type { BackgroundConfig } from '../types';
import { useState, useRef, useEffect, useCallback } from 'react';
import init, { CameraRig, Mp4Muxer } from '../../recorder_core/pkg/recorder_core';

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

    // Background State
    const [backgroundConfig, setBackgroundConfig] = useState<BackgroundConfig>({ type: 'solid', color: '#171717' });
    const backgroundRef = useRef<BackgroundConfig>({ type: 'solid', color: '#171717' });

    // Mouse tracking state
    const cursorRef = useRef({ x: 960, y: 540 }); // Start center
    const lastMouseMoveRef = useRef<number>(Date.now());
    const workerRef = useRef<Worker | null>(null);

    useEffect(() => {
        // Init Wasm
        init().then(() => {
            console.log("Wasm module initialized");
            setIsReady(true);
        });

        const handleMouseMove = (e: MouseEvent) => {
            cursorRef.current = { x: e.clientX, y: e.clientY };
            lastMouseMoveRef.current = Date.now();
        };
        window.addEventListener('mousemove', handleMouseMove);

        // Init Worker
        workerRef.current = new Worker(new URL('../workers/timer.worker.ts', import.meta.url), { type: 'module' });

        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            workerRef.current?.terminate();
        };
    }, []);

    const setBackground = useCallback((config: BackgroundConfig) => {
        setBackgroundConfig(config);
        backgroundRef.current = config;
    }, []);

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

            const track = displayMedia.getVideoTracks()[0];
            const settings = track.getSettings();
            const width = settings.width || 1920;
            const height = settings.height || 1080;

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
                if (!canvasRef.current || !rigRef.current) return;
                const ctx = canvasRef.current.getContext('2d');
                if (!ctx) return;

                // Update Physics
                rigRef.current.update(cursorRef.current.x, cursorRef.current.y, 1 / 60);
                const view = rigRef.current.get_view_rect();

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

                // 2. Draw Video Frame (Cropped & Centered)
                ctx.drawImage(
                    video,
                    view.x, view.y, view.width, view.height, // Source crop
                    0, 0, 1920, 1080 // Destination (Full frame)
                );

                // Create VideoFrame for Encoder
                const frame = new VideoFrame(canvasRef.current, { timestamp: performance.now() * 1000 });
                encoder.encode(frame, { keyFrame: frameCountRef.current % 60 === 0 });
                frame.close();

                frameCountRef.current++;
                // setInterval drives the loop, no recursion needed
            };

            video.onloadedmetadata = () => {
                console.log("Video loaded. Starting recording with setInterval.");
                // Use setInterval instead of rAF - runs even when tab is hidden
                requestRef.current = window.setInterval(() => draw(), 16); // ~60fps
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
    }, []);

    const stopRecording = useCallback(async () => {
        try {
            // Stop Worker Loop
            workerRef.current?.postMessage('stop');

            if (requestRef.current) {
                clearInterval(requestRef.current); // Changed from cancelAnimationFrame
                requestRef.current = 0;
            }
            setIsRecording(false);

            // Bring focus back to this window
            window.focus();
            // Optional: Notification or Alert to ensure user knows to come back if focus fails
            // alert("Recording Finished! View your video.");

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
