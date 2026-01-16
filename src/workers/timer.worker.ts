// Web Worker to drive the render loop at 60fps even when the main tab is backgrounded
let intervalId: number | null = null;

self.onmessage = (e) => {
    if (e.data === 'start') {
        if (intervalId) clearInterval(intervalId);
        intervalId = self.setInterval(() => {
            self.postMessage('tick');
        }, 1000 / 60); // 60 FPS
    } else if (e.data === 'stop') {
        if (intervalId) clearInterval(intervalId);
        intervalId = null;
    }
};
