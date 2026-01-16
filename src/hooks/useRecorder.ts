import { useState, useRef, useEffect, useCallback } from 'react';
import init, { CameraRig, Mp4Muxer } from '../../recorder_core/pkg/recorder_core';

export const useRecorder = () => {
    const [isRecording, setIsRecording] = useState(false);
    const [isReady, setIsReady] = useState(false);
    const [stream, setStream] = useState<MediaStream | null>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const requestRef = useRef<number>(0);
    const muxerRef = useRef<Mp4Muxer | null>(null);
    const rigRef = useRef<CameraRig | null>(null);
    const videoEncoderRef = useRef<VideoEncoder | null>(null);
    const frameCountRef = useRef(0);

    // Mouse tracking state
    const cursorRef = useRef({ x: 0, y: 0 });

    useEffect(() => {
        // Init Wasm
        init().then(() => {
            console.log("Wasm module initialized");
            setIsReady(true);
        });

        // Listen to mouse globally (simulating tracking)
        // Note: This only tracks mouse over the App window, not system-wide.
        // For real screen recording, this is a limitation unless we capture the cursor in the video 
        // and using CV (too complex for MVP).
        // We will assume "App Recording" or user moves mouse in the tab.
        const handleMouseMove = (e: MouseEvent) => {
            cursorRef.current = { x: e.clientX, y: e.clientY };
        };
        window.addEventListener('mousemove', handleMouseMove);
        return () => window.removeEventListener('mousemove', handleMouseMove);
    }, []);

    const startRecording = useCallback(async () => {
        try {
            const displayMedia = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    width: { ideal: 1920 },
                    height: { ideal: 1080 },
                    frameRate: 60,
                },
                audio: false
            });

            setStream(displayMedia);

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
            // We need a Video element to play the stream so we can draw it to canvas
            const video = document.createElement('video');
            video.srcObject = displayMedia;
            video.play();

            const draw = () => {
                if (!canvasRef.current || !rigRef.current) return;
                const ctx = canvasRef.current.getContext('2d');
                if (!ctx) return;

                // Update Physics
                // We map client coordinates to video coordinates roughly? 
                // Since we don't know the exact mapping if capturing full screen, 
                // we'll assume the interaction is Center for now or just standard physics test.
                // Or better: Let user drag a "Focus" element on screen.
                // For MVP: Target is Cursor.

                rigRef.current.update(cursorRef.current.x, cursorRef.current.y, 1 / 60);

                const view = rigRef.current.get_view_rect();

                // Draw Gradient BG
                // We create a "Canvas" for the output frame
                // Note: The PREVIEW canvas might be small, but we need to encode 1080p.
                // Creating a dedicated OffscreenCanvas for encoding is better.

                // Let's use the visible canvas for now (sized 1080p in memory?)
                canvasRef.current.width = 1920;
                canvasRef.current.height = 1080;

                // 1. Fill Gradient Background
                const gradient = ctx.createLinearGradient(0, 0, 1920, 1080);
                gradient.addColorStop(0, '#ff9a9e');
                gradient.addColorStop(1, '#fecfef');
                ctx.fillStyle = gradient;
                ctx.fillRect(0, 0, 1920, 1080);

                // 2. Draw Video Frame (Cropped & Centered)
                // We want to draw the 'view' rect from source video into the center of our 1920x1080 canvas
                // simulating a "camera" looking at that part.
                // Wait, if we crop, we zoom in.

                // Dest Rect: Full canvas?
                // Source Rect: view (x,y,w,h)

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

            // Start loop
            video.onloadedmetadata = () => {
                requestRef.current = requestAnimationFrame(draw);
            };

            setIsRecording(true);

            // Stop handler
            track.onended = stopRecording;

        } catch (err) {
            console.error("Error starting recording:", err);
        }
    }, []);

    const stopRecording = useCallback(async () => {
        if (requestRef.current) cancelAnimationFrame(requestRef.current);
        setIsRecording(false);

        if (videoEncoderRef.current) {
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
            const a = document.createElement('a');
            a.href = url;
            a.download = `recording-${Date.now()}.mp4`;
            a.click();
        }
    }, [stream]);

    return {
        isRecording,
        isReady,
        startRecording,
        stopRecording,
        canvasRef
    };
};
