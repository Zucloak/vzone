from playwright.sync_api import sync_playwright, expect
import time

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                "--use-fake-ui-for-media-stream",
                "--use-fake-device-for-media-stream"
            ]
        )

        page = browser.new_page()
        page.goto("http://localhost:5173/")

        # Wait for initialization (WASM)
        start_btn = page.locator("button", has_text="Start Recording")
        expect(start_btn).to_be_enabled(timeout=20000)

        # Verify Background Picker is GONE from start screen
        if page.get_by_text("Choose Background").is_visible():
             print("FAIL: Background picker found on start screen")
        else:
             print("PASS: Background picker not on start screen")

        # Take Screenshot of Start Screen
        page.screenshot(path="verification/verification.png")
        print("Screenshot saved.")

        browser.close()

if __name__ == "__main__":
    run()
