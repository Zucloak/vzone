// Web Worker to drive the render loop at configurable fps even when the main tab is backgrounded
let intervalId: number | null = null;

self.onmessage = (e) => {
    // Support both old string format and new object format for backwards compatibility
    if (e.data === 'start' || (e.data?.type === 'start')) {
        if (intervalId) clearInterval(intervalId);
        const fps = e.data?.fps || 60; // Default to 60 FPS if not specified
        intervalId = self.setInterval(() => {
            self.postMessage('tick');
        }, 1000 / fps);
    } else if (e.data === 'stop') {
        if (intervalId) clearInterval(intervalId);
        intervalId = null;
    }
};
