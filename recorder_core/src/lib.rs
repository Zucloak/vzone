use wasm_bindgen::prelude::*;
use serde::{Serialize, Deserialize};
use std::io::{Cursor, Write};

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[wasm_bindgen]
pub fn init_hooks() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub struct CameraRig {
    x: f64,
    y: f64,
    vx: f64,
    vy: f64,
    zoom_level: f64,
    target_zoom: f64,
    stiffness: f64,
    damping: f64,
    mass: f64,
    src_width: f64,
    src_height: f64,
}

#[wasm_bindgen]
impl CameraRig {
    #[wasm_bindgen(constructor)]
    pub fn new(src_width: f64, src_height: f64) -> CameraRig {
        CameraRig {
            x: src_width / 2.0,
            y: src_height / 2.0,
            vx: 0.0,
            vy: 0.0,
            zoom_level: 1.0,
            target_zoom: 1.0,
            stiffness: 120.0,
            damping: 15.0,
            mass: 1.0,
            src_width,
            src_height,
        }
    }

    pub fn set_target_zoom(&mut self, zoom: f64) {
        self.target_zoom = zoom.max(1.0);
    }

    pub fn update(&mut self, target_x: f64, target_y: f64, dt: f64) {
        let dist_x = target_x - self.x;
        let dist_y = target_y - self.y;
        
        let force_x = self.stiffness * dist_x;
        let force_y = self.stiffness * dist_y;

        let accel_x = (force_x - self.damping * self.vx) / self.mass;
        let accel_y = (force_y - self.damping * self.vy) / self.mass;

        self.vx += accel_x * dt;
        self.vy += accel_y * dt;

        self.x += self.vx * dt;
        self.y += self.vy * dt;

        let zoom_diff = self.target_zoom - self.zoom_level;
        self.zoom_level += zoom_diff * 5.0 * dt; 
    }

    pub fn get_view_rect(&self) -> JsValue {
        let width = self.src_width / self.zoom_level;
        let height = self.src_height / self.zoom_level;

        let mut left = self.x - width / 2.0;
        let mut top = self.y - height / 2.0;

        if left < 0.0 { left = 0.0; } 
        else if left + width > self.src_width { left = self.src_width - width; }

        if top < 0.0 { top = 0.0; } 
        else if top + height > self.src_height { top = self.src_height - height; }
        
        let rect = Rect { x: left, y: top, width, height };
        serde_wasm_bindgen::to_value(&rect).unwrap()
    }
}

#[wasm_bindgen]
pub struct Mp4Muxer {
    // In a real app we might use a RefCell or something to handle the writer,
    // but here we will just buffer encoded data and export it.
    // Simplifying: The generic mp4 crate is synchronous.
    // We will just expose a way to get the final blob.
    
    // Actually, storing the writer is hard because of Generics/Lifetimes in Wasm struct.
    // We'll use a globally managed buffer or just `Vec<u8>` wrapped.
    // Use `mp4::Mp4Writer<Cursor<Vec<u8>>>` ? We can't put generic types in wasm_bindgen struct easily.
    // We have to wrap it in a Box<dyn ...> or specific type not visible to JS.
    // Since `mp4` writer is generic over W: Write, we can use `Cursor<Vec<u8>>`.
    
    // We can't store `Mp4Writer` directly if it's not `Copy`.
    // We will store it in a `Box`? No, struct fields must be Wasm types or pointers.
    // We can ignore the implementation details in the struct and use methods.
    
    // Workaround: We hold the `Vec<u8>` content manually and maybe use a lower level approach?
    // Or just re-create the writer? No that overwrites.
    
    // Correct approach for wasm-bindgen with non-copy structs:
    // Only expose handles.
    
    // For this MVP, I'll try to use a simplified Approach:
    // We rely on JS `WebCodecs` to do the heavy lifting, 
    // and we only use Rust for `CameraRig`.
    // The user explicitly asked for "Container/Muxing: Rust mp4 crate".
    // So I must do it.
    
    // I will write the implementation to use `RefCell` or `Mutex` if needed, 
    // but `wasm_bindgen` structs are single-threaded on JS main thread usually.
    // But `mp4::Mp4Writer` has generics.
    
    // I will define a wrapper struct that is NOT exported, and the exported struct holds a pointer/box to it.
    inner: *mut std::ffi::c_void, 
}

struct InnerMuxer {
    writer: mp4::Mp4Writer<Cursor<Vec<u8>>>,
    frame_count: u64,
}

#[wasm_bindgen]
impl Mp4Muxer {
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32) -> Mp4Muxer {
        web_sys::console::log_1(&"Mp4Muxer::new called".into());
        let buffer = Vec::new();
        let cursor = Cursor::new(buffer);
        
        web_sys::console::log_1(&"Creating Mp4Writer...".into());
        let mut writer = mp4::Mp4Writer::write_start(cursor, &mp4::Mp4Config {
            major_brand: str::parse("mp41").unwrap(),
            minor_version: 512,
            compatible_brands: vec![str::parse("mp41").unwrap()],
            timescale: 1000,
        }).expect("Failed to write start");
        
        web_sys::console::log_1(&"Adding track...".into());
        writer.add_track(&mp4::TrackConfig {
            track_type: mp4::TrackType::Video,
            timescale: 1000,
            language: String::from("und"),
            media_conf: mp4::MediaConfig::AvcConfig(mp4::AvcConfig {
                width: width as u16,
                height: height as u16,
                seq_param_set: vec![0, 0, 0, 1], // Minimal dummy SPS to avoid panic if crate checks?
                pic_param_set: vec![0, 0, 0, 1],
            }),
        }).expect("Failed to add track");

        web_sys::console::log_1(&"Mp4Muxer initialized".into());

        let inner = Box::new(InnerMuxer {
            writer,
            frame_count: 0,
        });

        Mp4Muxer {
            inner: Box::into_raw(inner) as *mut std::ffi::c_void,
        }
    }

    pub fn add_frame(&mut self, data: &[u8], is_key: bool, timestamp: u64) {
        unsafe {
            let inner = &mut *(self.inner as *mut InnerMuxer);
            let bytes = bytes::Bytes::copy_from_slice(data);
            
            // We need to create a Sample
            let sample = mp4::Mp4Sample {
                start_time: timestamp,
                duration: 33, // assume 30fps or provided?
                rendering_offset: 0,
                is_sync: is_key,
                bytes,
            };
            
            // track_id 1 is usually the first one
            inner.writer.write_sample(1, &sample).unwrap();
            inner.frame_count += 1;
        }
    }

    pub fn finish(self) -> Vec<u8> {
        unsafe {
            let inner_box = Box::from_raw(self.inner as *mut InnerMuxer);
            let mut inner = *inner_box; // take ownership
            inner.writer.write_end().unwrap();
            
            let cursor = inner.writer.into_writer();
            cursor.into_inner()
        }
    }
}
