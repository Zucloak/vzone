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

    // Background State (Ref for render loop access)
    const backgroundRef = useRef<BackgroundConfig>({ type: 'solid', color: '#171717' });

    // Mouse tracking state
    const cursorRef = useRef({ x: 0, y: 0 });

    useEffect(() => {
        // Init Wasm
        init().then(() => {
            console.log("Wasm module initialized");
            setIsReady(true);
        });

        const handleMouseMove = (e: MouseEvent) => {
            cursorRef.current = { x: e.clientX, y: e.clientY };
        };
        window.addEventListener('mousemove', handleMouseMove);
        return () => window.removeEventListener('mousemove', handleMouseMove);
    }, []);

    const setBackground = useCallback((config: BackgroundConfig) => {
        backgroundRef.current = config;
    }, []);

    const startRecording = useCallback(async () => {
        try {
            const displayMedia = await navigator.mediaDevices.getDisplayMedia({
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

            // Initialize Muxer
            muxerRef.current = new Mp4Muxer(1920, 1080); // Output size 1080p

            // Initialize VideoEncoder
            const encoder = new VideoEncoder({
                output: (chunk, _metadata) => {
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
                codec: 'avc1.42001f', // Baseline 3.1
                width: 1920,
                height: 1080,
                bitrate: 5_000_000, // 5 Mbps
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
                requestRef.current = requestAnimationFrame(draw);
            };

            video.onloadedmetadata = () => {
                requestRef.current = requestAnimationFrame(draw);
            };

            setIsRecording(true);

            // Stop handler
            track.onended = () => {
                stopRecording();
            };

        } catch (err) {
            console.error("Error starting recording:", err);
            setIsRecording(false);
        }
    }, []);

    const stopRecording = useCallback(async () => {
        if (requestRef.current) cancelAnimationFrame(requestRef.current);
        setIsRecording(false);

        if (videoEncoderRef.current && videoEncoderRef.current.state !== 'closed') {
            await videoEncoderRef.current.flush();
            videoEncoderRef.current.close();
        }

        if (stream) {
            stream.getTracks().forEach(t => t.stop());
            setStream(null);
        }

        if (muxerRef.current) {
            const bytes = muxerRef.current.finish();
            const blob = new Blob([bytes as unknown as BlobPart], { type: 'video/mp4' });
            const url = URL.createObjectURL(blob);
            setPreviewBlobUrl(url);
            muxerRef.current = null; // Reset muxer
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
        backgroundConfig: backgroundRef.current
    };
};
