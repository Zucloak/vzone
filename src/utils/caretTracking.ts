/**
 * Caret Tracking Utility
 * 
 * Provides functions to detect and track the position of the text caret (input cursor)
 * for the Targeted Zoom System. This enables zooming to the text cursor when typing.
 */

/**
 * Get the screen coordinates of the text caret/cursor
 * 
 * @returns {x: number, y: number} | null - Screen coordinates of the caret, or null if not found
 */
export function getCaretCoordinates(): { x: number; y: number } | null {
    // Try to get selection first (works for contentEditable and text selections)
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0).cloneRange();
        range.collapse(false); // Collapse to end of range (caret position)
        const rect = range.getBoundingClientRect();
        
        // Valid rect with actual coordinates
        if (rect.width > 0 || rect.height > 0 || rect.x > 0 || rect.y > 0) {
            return { 
                x: rect.x + rect.width / 2, 
                y: rect.y + rect.height / 2 
            };
        }
    }
    
    // Fallback for input/textarea elements
    const activeElement = document.activeElement as HTMLInputElement | HTMLTextAreaElement;
    if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')) {
        try {
            // For input/textarea, we need to create a temporary element to measure caret position
            const rect = activeElement.getBoundingClientRect();
            const computedStyle = window.getComputedStyle(activeElement);
            
            // Use a simple heuristic: caret is likely near the left edge for empty/start
            // For more accuracy, we'd need to measure text width up to caret position
            const value = activeElement.value || '';
            const selectionStart = activeElement.selectionStart || 0;
            
            // Create temporary span to measure text width
            const tempSpan = document.createElement('span');
            tempSpan.style.font = computedStyle.font;
            tempSpan.style.fontSize = computedStyle.fontSize;
            tempSpan.style.fontFamily = computedStyle.fontFamily;
            tempSpan.style.fontWeight = computedStyle.fontWeight;
            tempSpan.style.letterSpacing = computedStyle.letterSpacing;
            tempSpan.style.position = 'absolute';
            tempSpan.style.visibility = 'hidden';
            tempSpan.style.whiteSpace = 'pre';
            tempSpan.textContent = value.substring(0, selectionStart);
            
            document.body.appendChild(tempSpan);
            const textWidth = tempSpan.getBoundingClientRect().width;
            document.body.removeChild(tempSpan);
            
            // Calculate approximate caret position
            const paddingLeft = parseFloat(computedStyle.paddingLeft) || 0;
            const caretX = rect.left + paddingLeft + textWidth;
            const caretY = rect.top + rect.height / 2; // Middle of input
            
            return { x: caretX, y: caretY };
        } catch (error) {
            console.warn('Error measuring caret position:', error);
            // Fallback to element center
            const rect = activeElement.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }
    }
    
    return null;
}

/**
 * Get the currently focused/active input element
 * 
 * @returns HTMLElement | null - The active input element, or null
 */
export function getActiveInputElement(): HTMLElement | null {
    const activeElement = document.activeElement as HTMLElement;
    
    if (!activeElement) return null;
    
    // Check if it's an input-like element
    const tag = activeElement.tagName;
    const isContentEditable = activeElement.isContentEditable;
    const isInput = tag === 'INPUT' || tag === 'TEXTAREA';
    
    if (isInput || isContentEditable) {
        return activeElement;
    }
    
    return null;
}

/**
 * Check if the user is currently typing in an input field
 * 
 * @returns boolean - True if actively typing
 */
export function isTypingActive(): boolean {
    return getActiveInputElement() !== null;
}
