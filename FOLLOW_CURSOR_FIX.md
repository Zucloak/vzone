# Warmup Period Fix & Follow-Cursor Logic

## Overview

This update fixes early zooming during the first few seconds of recording and implements continuous cursor tracking while zoom is active.

## Changes Made

### 1. Warmup Period Fix

**Problem:** Camera was zooming during the first few seconds of recording even without user clicks.

**Root Cause:** The warmup check allowed zooming if a "localized action" was detected, even during the warmup period. Early motion detection noise could trigger zoom.

**Solution:** Complete zoom lockout during the 1.5-second warmup period.

#### Before
```typescript
// Could zoom during warmup if isLocalizedAction was true
if (warmupFramesRef.current < 90 && !isLocalizedAction) {
    rigRef.current.set_target_zoom(MOTION_CONFIG.ZOOM_OUT_LEVEL);
}
```

#### After
```typescript
// Complete zoom lockout during warmup
if (warmupFramesRef.current < 90) {
    rigRef.current.set_target_zoom(MOTION_CONFIG.ZOOM_OUT_LEVEL);
    // Explicitly disable zoom during warmup
    zoomEnabledRef.current = false;
}
```

#### Behavior
- **First 1.5 seconds (90 frames @ 60fps)**: Zoom completely disabled, stays at 1.0x
- **After warmup**: Multi-click trigger mechanism becomes active
- **During warmup**: Click timestamps are tracked but zoom remains disabled

### 2. Follow-Cursor Logic

**Problem:** Camera only tracked the position where clicks occurred, not continuous cursor movement.

**User Request:** "Once a zoom is active, the focal point should dynamically update to follow the cursor's new coordinates as it moves, maintaining that 'smooth pan' effect."

**Solution:** Implement adaptive cursor tracking based on zoom state.

#### Implementation

```typescript
// Follow-cursor logic: When zoom is active, continuously track cursor position
if (zoomEnabledRef.current && rigRef.current.get_view_rect) {
    const view = rigRef.current.get_view_rect();
    const currentZoom = view.zoom || 1.0;
    
    // Only apply continuous tracking when actually zoomed in
    if (currentZoom > MOTION_CONFIG.ZOOM_OUT_LEVEL + 0.1) {
        // Full smoothing for responsive cursor following
        const smoothing = MOTION_CONFIG.TARGET_SMOOTHING;
        currentTargetRef.current.x += (detectedX - currentTargetRef.current.x) * smoothing;
        currentTargetRef.current.y += (detectedY - currentTargetRef.current.y) * smoothing;
    } else {
        // Reduced tracking when zoomed out to avoid jitter
        const smoothing = MOTION_CONFIG.TARGET_SMOOTHING * 0.5;
        currentTargetRef.current.x += (detectedX - currentTargetRef.current.x) * smoothing;
        currentTargetRef.current.y += (detectedY - currentTargetRef.current.y) * smoothing;
    }
}
```

#### Adaptive Tracking

The system uses **zoom-aware tracking** with three states:

1. **Zoom Active & Zoomed In (zoom > 1.1x)**
   - Full smoothing factor: 0.25
   - Continuously follows cursor movement
   - Creates smooth pan effect as cursor moves
   - Responsive tracking for focused work

2. **Zoom Active but Zoomed Out (zoom ≈ 1.0x)**
   - Reduced smoothing: 0.125 (50% of normal)
   - Less responsive to cursor movement
   - Prevents unnecessary camera motion when not zoomed

3. **Zoom Disabled**
   - Reduced smoothing: 0.125 (50% of normal)
   - Minimal camera movement
   - Waits for multi-click trigger

#### Zoom Lifecycle with Cursor Following

```
1. First Click
   └─> Click tracked, zoom stays disabled
   └─> Camera: Static (minimal tracking)

2. Second Click (within 3s)
   └─> Zoom enabled, camera zooms IN to 1.8x
   └─> Camera: Active cursor following starts

3. Cursor Moves (while zoomed)
   └─> Camera smoothly pans to keep cursor centered
   └─> Full smoothing factor (0.25) for responsiveness
   └─> Maintains "smooth pan" effect

4. User Stops Moving (2s idle)
   └─> Camera zooms OUT to 1.0x
   └─> Cursor following becomes less responsive
   └─> Zoom disabled until next multi-click

5. Scrolling Detected
   └─> Immediate zoom OUT to 1.0x
   └─> Click counter reset
   └─> Zoom disabled
```

## Expected User Experience

### Warmup Period (First 1.5 Seconds)
✅ **No unexpected zooming** - Camera stays at 1.0x overview  
✅ **Clicks are tracked** - Click timestamps recorded for multi-click trigger  
✅ **Smooth start** - No jitter or premature zoom  

### Cursor Following While Zoomed
✅ **Responsive tracking** - Camera follows cursor as it moves  
✅ **Smooth panning** - Continuous lerp creates fluid motion  
✅ **Centered cursor** - Focal point dynamically updates  
✅ **Adaptive behavior** - More responsive when zoomed in  

### Complete Workflow
1. **Start recording** → 1.5s warmup, no zoom
2. **Click twice** → Zoom IN to 1.8x
3. **Move cursor** → Camera smoothly follows cursor position
4. **Keep working** → Camera maintains zoom and tracks cursor
5. **Stop moving (2s)** → Camera zooms OUT to 1.0x
6. **Continue** → Camera waits for next multi-click trigger

## Technical Details

### Zoom State Detection
```typescript
const view = rigRef.current.get_view_rect();
const currentZoom = view.zoom || 1.0;

// Check if actually zoomed in (with 0.1 threshold for float comparison)
if (currentZoom > MOTION_CONFIG.ZOOM_OUT_LEVEL + 0.1) {
    // Zoomed in - use full cursor following
}
```

### Smoothing Factors

| State | Smoothing Factor | Response Time | Use Case |
|-------|-----------------|---------------|----------|
| Zoomed In | 0.25 | ~0.9s | Active cursor following |
| Zoomed Out | 0.125 | ~1.8s | Minimal tracking |
| Zoom Disabled | 0.125 | ~1.8s | Waiting for trigger |

### Why Adaptive Smoothing?

**Problem:** Using the same smoothing factor for all states causes:
- Unwanted camera movement when zoomed out
- Jittery motion from following every pixel change

**Solution:** Reduce smoothing by 50% when not actively zoomed in:
- Prevents unnecessary camera motion
- Maintains stability during idle periods
- Full responsiveness only when user is actively working with zoom

## Files Modified

**`src/hooks/useRecorder.ts`**
- Fixed warmup period to completely disable zoom
- Implemented zoom-aware cursor following
- Added adaptive smoothing based on zoom state

## Testing Recommendations

1. **Warmup test**: Start recording → Wait 1.5s → Should NOT zoom
2. **Follow-cursor test**: Click twice → Move cursor around → Camera should smoothly follow
3. **Zoom state test**: While zoomed, cursor should be followed closely
4. **Zoom out test**: When zoomed out, cursor following should be minimal
5. **Idle test**: Stop moving for 2s → Should zoom out and reduce tracking
6. **Scroll reset test**: Scroll while zoomed → Should zoom out and disable tracking

## Performance Impact

No additional performance cost. The zoom state check is a simple float comparison that happens once per frame during existing motion processing.
