# Targeted Zoom System - Implementation Documentation

## Overview

This document explains the implementation of the Targeted Zoom System for the V.ZONE screen recorder, a Cursorful clone that provides intelligent focus and zoom behaviors during screen recording.

## System Architecture

### 1. Core Components

#### Caret Tracking Utility (`src/utils/caretTracking.ts`)
Provides functions to detect and track text cursor positions:

- **`getCaretCoordinates()`**: Returns screen coordinates `{x, y}` of the text caret
  - For selections: Uses `window.getSelection()` and `getBoundingClientRect()`
  - For input/textarea: Creates temporary span element to measure text width up to caret position
  - Returns `null` if no caret is found

- **`getActiveInputElement()`**: Returns the currently focused input element
  - Checks for INPUT, TEXTAREA, or contentEditable elements
  - Returns `null` if no input element is focused

- **`isTypingActive()`**: Boolean check if user is actively typing

#### Recorder Hook (`src/hooks/useRecorder.ts`)
Enhanced with typing detection and zoom coordination:

**New State Refs:**
```typescript
lastKeyTimeRef: useRef<number>(0)           // Timestamp of last keypress
typingTargetRef: useRef<{x, y} | null>(null) // Last known caret position
isTypingModeRef: useRef<boolean>(false)     // Whether in typing mode
keydownHandlerRef: useRef<Handler | null>   // Event listener reference
```

### 2. Zoom Math & Matrix Transformations

The system uses proper matrix transformations to ensure coordinated zoom:

```typescript
// Canvas transformation order (in useRecorder.ts, lines 577-581):
ctx.translate(width / 2, height / 2);  // 1. Move origin to canvas center
ctx.scale(view.zoom, view.zoom);       // 2. Apply zoom scale
ctx.translate(-view.x, -view.y);       // 3. Move focal point to center
ctx.drawImage(video, 0, 0, width, height);
ctx.restore();
```

**Why this order matters:**
- First translate moves the coordinate system center to the canvas center
- Scale expands/contracts around the new center
- Second translate positions the focal point (mouse or caret) at the center
- This prevents zoom "drift" where the zoom point moves during scaling

### 3. Dual Trigger System

#### Mouse Zoom (Existing)
- **Detection**: Pixel-based motion analysis on 64x36 downsampled buffer
- **Triggers**: 
  - Localized actions (clicks): Area < 150px², compact dimensions
  - Scrolling: Height change > 5px, wide area
- **Zoom Behavior**:
  - Clicks → Zoom IN (1.8x)
  - Scrolling → Zoom OUT (1.0x)
  - Idle (2s) → Zoom OUT (1.0x)

#### Typing Zoom (New)
- **Detection**: Global `keydown` event listener with input element check
- **Triggers**:
  - User types in INPUT, TEXTAREA, or contentEditable element
  - Ignores modifier keys (Shift, Ctrl, Alt, arrows, function keys)
- **Zoom Behavior**:
  - Typing detected → Zoom IN (1.8x)
  - Follows caret position with smooth lerp (factor: 0.1)
  - Idle typing (2s) → Zoom OUT (1.0x)

### 4. Hybrid Logic & Priority System

**Priority Hierarchy:**
```
1. SCROLLING (Highest Priority)
   └─> Always zoom OUT for context
   
2. TYPING MODE
   └─> Zoom IN and follow caret
   └─> Override: Mouse motion disables typing mode
   
3. LOCALIZED CLICKS
   └─> Zoom IN on click point
   
4. LIGHT MOTION
   └─> Maintain current zoom
   
5. IDLE (Lowest Priority)
   └─> Zoom OUT after 2 seconds
```

**Mouse Override Logic** (lines 478-485 in useRecorder.ts):
```typescript
if (isTypingModeRef.current && totalMass > MIN_MASS) {
    // Significant mouse motion detected while typing
    isTypingModeRef.current = false;
    typingTargetRef.current = null;
}
```

### 5. Smooth Interpolation (Lerp)

**For Typing Position** (lines 562-568):
```typescript
const lerpFactor = 0.1; // Cinematic smoothness
currentTargetRef.current.x = currentTargetRef.current.x + 
    (typingTargetRef.target.x - currentTargetRef.current.x) * lerpFactor;
currentTargetRef.current.y = currentTargetRef.current.y + 
    (typingTargetRef.target.y - currentTargetRef.current.y) * lerpFactor;
```

**For Zoom Level** (in Rust CameraRig, lib.rs lines 75-76):
```rust
let zoom_diff = self.target_zoom - self.zoom_level;
self.zoom_level += zoom_diff * ZOOM_TRANSITION_SPEED * dt;
```

**Physics-Based Pan** (lib.rs lines 98-112):
- Spring-damper system with:
  - Stiffness: 140.0
  - Critical damping: 23.66
  - Prevents overshoot and oscillation

### 6. Technical Details

#### Coordinate System Mapping
```
Screen Coordinates (from getCaretCoordinates)
          ↓
Video Coordinates (for recording)
          ↓
CameraRig Target (smooth physics)
          ↓
Canvas Transform (final render)
```

**Note:** Current implementation uses screen coordinates directly. For multi-monitor setups, you may need to offset by the display media's screen position.

#### Timing & Frame Rates
- **Physics Update**: 60 FPS (smooth camera movement)
- **Video Encoding**: 30 FPS (performance balance)
- **Warmup Period**: 1.5 seconds (90 frames @ 60fps) to prevent startup jitter
- **Idle Timeout**: 2 seconds for both typing and motion

#### Event Listener Management
- **Attached**: During `startRecording()` after video.play()
- **Removed**: During `stopRecording()` before focus return
- **Stored**: In `keydownHandlerRef` for proper cleanup
- **Scope**: Global window event (detects typing anywhere on screen)

### 7. Configuration Constants

Located in `MOTION_CONFIG` (lines 6-24 in useRecorder.ts):

```typescript
MOTION_CONFIG = {
    ZOOM_MIN_MASS: 2,              // Ultra-sensitive click detection
    ZOOM_IN_LEVEL: 1.8,            // Focused zoom (clicks, typing)
    ZOOM_OUT_LEVEL: 1.0,           // Overview zoom (scrolling, idle)
    LOCALIZED_ACTION_AREA: 150,    // Max area for click (px²)
    SCROLL_HEIGHT_THRESHOLD: 5,    // Vertical scroll detection
}
```

## Usage Example

1. **User starts recording**: Click "Start Recording" button
2. **Types in a text field**: 
   - System detects keypress
   - Calculates caret position using `getCaretCoordinates()`
   - Zooms IN to 1.8x
   - Smoothly pans to center caret in frame
3. **User moves mouse while typing**:
   - Mouse motion detected via pixel analysis
   - Typing mode disabled
   - Camera follows mouse instead
4. **User stops typing**:
   - After 2 seconds of no keypresses
   - Zooms OUT to 1.0x overview
   - Returns to motion-based tracking

## Performance Considerations

- **Caret Tracking**: Only runs on keydown (not every frame)
- **Temporary DOM Elements**: Cleaned up immediately after measurement
- **Motion Detection**: Low-res 64x36 buffer (36× smaller than full screen)
- **Physics**: Wasm-based for performance (Rust CameraRig)

## Known Limitations

1. **Multi-Monitor**: Caret coordinates may need offset for displays not at (0,0)
2. **Browser Compatibility**: `getSelection()` API works in modern browsers only
3. **Typing Detection**: Requires focus on INPUT, TEXTAREA, or contentEditable
4. **No DOM Inspection**: Cannot detect typing in canvas-based editors

## Future Enhancements

- [ ] Multi-monitor coordinate offset detection
- [ ] Adaptive lerp factor based on typing speed
- [ ] Per-element zoom preferences (e.g., code editors zoom more)
- [ ] Visual indicator showing current zoom target (debug mode)
- [ ] Configurable timeout durations via UI settings

## Testing Checklist

- [x] Build succeeds without errors
- [ ] Typing in text input zooms IN
- [ ] Caret position is centered in frame
- [ ] Zoom OUT after 2s of no typing
- [ ] Mouse movement overrides typing mode
- [ ] Click detection still works
- [ ] Scrolling still zooms OUT
- [ ] Event listener properly cleaned up on stop
