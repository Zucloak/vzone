use wasm_bindgen::prelude::*;
use serde::{Serialize, Deserialize};
use std::io::Cursor;

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
            stiffness: 80.0,  // Increased for faster response
            damping: 17.89,   // Critically Damped: 2 * sqrt(stiffness) = 2 * sqrt(80) ≈ 17.89
            mass: 1.0,
            src_width,
            src_height,
        }
    }

    pub fn set_target_zoom(&mut self, zoom: f64) {
        self.target_zoom = zoom.max(1.0);
    }

    pub fn update(&mut self, target_x: f64, target_y: f64, dt: f64) {
        // Smooth zoom first to know our constraints
        let zoom_diff = self.target_zoom - self.zoom_level;
        self.zoom_level += zoom_diff * 5.0 * dt; // Faster, smoother zoom transition
        
        // Clamp zoom to safe range (1.0 = no zoom, 2.0 = 2x zoom)
        self.zoom_level = self.zoom_level.clamp(1.0, 2.5);

        // Calculate view dimensions at current zoom
        // When zoomed in, we see less of the source video
        let view_w = self.src_width / self.zoom_level;
        let view_h = self.src_height / self.zoom_level;

        // Calculate safe bounds for camera position
        // The camera (x, y) represents the center of our view
        // So min/max are constrained to keep the view within source bounds
        let min_x = view_w / 2.0;
        let max_x = self.src_width - view_w / 2.0;
        let min_y = view_h / 2.0;
        let max_y = self.src_height - view_h / 2.0;

        // Clamp target to valid bounds before applying physics
        let clamped_target_x = target_x.clamp(min_x, max_x);
        let clamped_target_y = target_y.clamp(min_y, max_y);
        
        // Apply physics to x,y using clamped target
        let dist_x = clamped_target_x - self.x;
        let dist_y = clamped_target_y - self.y;
        
        let force_x = self.stiffness * dist_x;
        let force_y = self.stiffness * dist_y;

        let accel_x = (force_x - self.damping * self.vx) / self.mass;
        let accel_y = (force_y - self.damping * self.vy) / self.mass;

        self.vx += accel_x * dt;
        self.vy += accel_y * dt;

        self.x += self.vx * dt;
        self.y += self.vy * dt;

        // Final clamp to ensure we never exceed bounds (safety net)
        if self.x < min_x { 
            self.x = min_x; 
            self.vx = 0.0; 
        }
        if self.x > max_x { 
            self.x = max_x; 
            self.vx = 0.0; 
        }
        if self.y < min_y { 
            self.y = min_y; 
            self.vy = 0.0; 
        }
        if self.y > max_y { 
            self.y = max_y; 
            self.vy = 0.0; 
        }
    }

    pub fn get_view_rect(&self) -> JsValue {
        // Return centered coordinates and scale
        // JS will use these to apply a transform
        #[derive(Serialize)]
        struct ViewState {
            x: f64,
            y: f64,
            zoom: f64,
        }
        
        let state = ViewState {
            x: self.x,
            y: self.y,
            zoom: self.zoom_level,
        };
        serde_wasm_bindgen::to_value(&state).unwrap()
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
    last_timestamp: u64,
}

#[wasm_bindgen]
impl Mp4Muxer {
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32, description: &[u8]) -> Mp4Muxer {
        web_sys::console::log_1(&"Mp4Muxer::new called with config".into());
        
        // Parse AVCC (description)
        // Format: [ver, profile, compat, level, len_size_minus_1, num_sps, (sps_len, sps)..., num_pps, (pps_len, pps)...]
        
        let mut sps = vec![];
        let mut pps = vec![];
        
        if description.len() > 6 {
            // Byte 5 is num_sps (usually with lower 5 bits, effectively usually 1)
            let num_sps = description[5] & 0x1F;
            let mut offset = 6;
            
            if num_sps > 0 {
                // Read first SPS
                if offset + 2 <= description.len() {
                    let sps_len = ((description[offset] as usize) << 8) | (description[offset + 1] as usize);
                    offset += 2;
                     if offset + sps_len <= description.len() {
                        sps = description[offset..offset + sps_len].to_vec();
                        offset += sps_len;
                     }
                }
            }
             
            // Read PPS
             if offset < description.len() {
                 let num_pps = description[offset];
                 offset += 1;
                 if num_pps > 0 {
                     if offset + 2 <= description.len() {
                        let pps_len = ((description[offset] as usize) << 8) | (description[offset + 1] as usize);
                        offset += 2;
                        if offset + pps_len <= description.len() {
                            pps = description[offset..offset + pps_len].to_vec();
                        }
                     }
                 }
             }
        }
        
        if sps.is_empty() || pps.is_empty() {
            web_sys::console::warn_1(&"Failed to parse AVCC, using dummy values. Video might be black.".into());
            sps = vec![0, 0, 0, 1];
            pps = vec![0, 0, 0, 1];
        } else {
             web_sys::console::log_1(&format!("Parsed SPS (len={}) and PPS (len={})", sps.len(), pps.len()).into());
        }

        let buffer = Vec::new();
        let cursor = Cursor::new(buffer);
        
        web_sys::console::log_1(&"Creating Mp4Writer...".into());
        let brand = "isom".parse().map_err(|_| "Failed to parse brand").unwrap();
        
        let mut writer = mp4::Mp4Writer::write_start(cursor, &mp4::Mp4Config {
            major_brand: brand,
            minor_version: 512,
            compatible_brands: vec![brand],
            timescale: 1_000_000, // microseconds to match VideoFrame timestamps
        }).expect("Failed to write start");
        
        web_sys::console::log_1(&"Adding track...".into());
        writer.add_track(&mp4::TrackConfig {
            track_type: mp4::TrackType::Video,
            timescale: 1_000_000, // microseconds to match VideoFrame timestamps
            language: String::from("und"),
            media_conf: mp4::MediaConfig::AvcConfig(mp4::AvcConfig {
                width: width as u16,
                height: height as u16,
                seq_param_set: sps, 
                pic_param_set: pps,
            }),
        }).expect("Failed to add track");

        web_sys::console::log_1(&"Mp4Muxer initialized".into());

        let inner = Box::new(InnerMuxer {
            writer,
            frame_count: 0,
            last_timestamp: 0,
        });

        Mp4Muxer {
            inner: Box::into_raw(inner) as *mut std::ffi::c_void,
        }
    }

    pub fn add_frame(&mut self, data: &[u8], is_key: bool, timestamp: u64) {
        unsafe {
            let inner = &mut *(self.inner as *mut InnerMuxer);
            let bytes = bytes::Bytes::copy_from_slice(data);
            
            // Calculate accurate duration based on timestamp difference
            // For 60fps, default duration is ~16666 microseconds
            let duration = if inner.frame_count == 0 {
                16666 // ~60fps for first frame
            } else {
                (timestamp - inner.last_timestamp).max(1) as u32
            };
            
            inner.last_timestamp = timestamp;
            
            // We need to create a Sample
            let sample = mp4::Mp4Sample {
                start_time: timestamp,
                duration, // accurate duration based on timestamps
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
