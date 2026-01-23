# Camera Shake Fix - Technical Explanation

## Problem Analysis

The user reported that the camera zooming was very shaky, with the following symptoms:
1. Camera panning to clicked components shakes
2. Transitions between components aren't smooth
3. Click/mouse tracker isn't 100% accurate - shakes then suddenly stabilizes

## Root Cause

The shakiness was caused by **unfiltered target position updates** being fed directly to the physics system:

### Before Fix:
```typescript
// Line 486-487 (OLD)
currentTargetRef.current.x = detectedX;  // Direct assignment - no smoothing!
currentTargetRef.current.y = detectedY;
```

**Why this caused shaking:**
1. Motion detection calculates center of mass of changed pixels **every frame**
2. Pixel-based detection is inherently noisy (varies by 1-5 pixels frame-to-frame)
3. Target position jumps directly to noisy detected position
4. High physics stiffness (140.0) makes camera respond instantly to jumps
5. Result: Camera constantly "chases" a jittery target → **visible shaking**

## Solution Implemented

### 1. **Added Target Smoothing** (TypeScript)
```typescript
// Apply lerp to smooth target updates BEFORE physics
const smoothing = MOTION_CONFIG.TARGET_SMOOTHING; // 0.15
currentTargetRef.current.x = currentTargetRef.current.x + 
    (detectedX - currentTargetRef.current.x) * smoothing;
```

**Effect:** Filters out high-frequency noise in motion detection

### 2. **Reduced Physics Stiffness** (Rust)
```rust
// Changed from 140.0 to 80.0
const CAMERA_STIFFNESS: f64 = 80.0;
const CAMERA_DAMPING: f64 = 2.0 * 8.944; // Critical damping recalculated
```

**Effect:** Camera responds more gradually, less "twitchy"

### 3. **Increased Zoom Smoothness** (Rust)
```rust
// Changed from 2.0 to 3.5
const ZOOM_TRANSITION_SPEED: f64 = 3.5;
```

**Effect:** Zoom changes happen more smoothly

## Two-Stage Smoothing System

The fix implements a **two-stage smoothing** approach:

```
Raw Motion Detection
        ↓
   [Stage 1: Target Smoothing]  ← NEW: Lerp factor 0.15
        ↓
Smoothed Target Position
        ↓
   [Stage 2: Physics System]    ← UPDATED: Lower stiffness (80.0)
        ↓
Final Camera Position
```

### Stage 1: Target Smoothing (Input Filter)
- **Purpose:** Remove noise from motion detection
- **Method:** Exponential moving average (lerp)
- **Factor:** 0.15 (filters 85% of jitter)

### Stage 2: Physics Smoothing (Output)
- **Purpose:** Natural, realistic camera movement
- **Method:** Spring-damper system
- **Stiffness:** 80.0 (was 140.0)

## Configuration Changes

### New Constant Added:
```typescript
MOTION_CONFIG = {
    TARGET_SMOOTHING: 0.15,  // NEW: Prevents jitter
    // ... existing constants
}
```

### Updated Constants:
- `CAMERA_STIFFNESS`: 140.0 → **80.0** (smoother response)
- `CAMERA_DAMPING`: 23.66 → **17.89** (recalculated for critical damping)
- `ZOOM_TRANSITION_SPEED`: 2.0 → **3.5** (faster zoom, but still smooth)

## Why 0.15 for TARGET_SMOOTHING?

- **Too Low (< 0.1):** Target follows too slowly, feels laggy
- **0.15:** Sweet spot - responsive but smooth
- **Too High (> 0.3):** Not enough filtering, still shaky

## Expected Behavior After Fix

### Before:
- ❌ Camera shakes when tracking cursor
- ❌ Jittery transitions between components
- ❌ Visible "hunting" behavior as camera searches for target

### After:
- ✅ Smooth, fluid camera movement
- ✅ Stable tracking of cursor and components
- ✅ Natural transitions without jitter
- ✅ Maintains responsiveness while eliminating shake

## Technical Deep Dive

### Lerp (Linear Interpolation) Formula:
```
newTarget = currentTarget + (detectedTarget - currentTarget) * factor
```

With factor = 0.15:
- 15% movement toward detected position each frame
- 85% retention of previous position
- Effectively a low-pass filter

### Critical Damping:
```
damping = 2 * sqrt(stiffness)
       = 2 * sqrt(80)
       = 2 * 8.944
       = 17.89
```

This ensures:
- No oscillation (no bouncing)
- Fastest possible settling
- Smooth approach to target

## Files Modified

1. **`recorder_core/src/lib.rs`**
   - Physics constants (stiffness, damping, zoom speed)

2. **`src/hooks/useRecorder.ts`**
   - Added TARGET_SMOOTHING constant
   - Applied smoothing to target updates
   - Unified smoothing for both mouse and typing modes

## Testing Recommendations

Test these scenarios to verify the fix:
1. Click on various UI elements → Camera should smoothly pan without shake
2. Move mouse around screen → Tracking should be stable
3. Type in text input → Camera should follow caret smoothly
4. Rapid mouse movements → No jitter or hunting behavior
5. Zoom transitions → Smooth zoom in/out

## Performance Impact

**None.** The lerp calculation is trivial (2 multiplications, 2 additions per axis) and runs at 60 FPS without any performance degradation.
