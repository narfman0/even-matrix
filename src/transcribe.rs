use anyhow::Result;
use std::sync::Arc;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

pub struct WhisperTranscriber {
    ctx: Arc<WhisperContext>,
}

// WhisperContext wraps a whisper.cpp context pointer that is safe to share across threads.
unsafe impl Send for WhisperTranscriber {}
unsafe impl Sync for WhisperTranscriber {}

impl WhisperTranscriber {
    pub fn new(model_path: &str) -> Result<Self> {
        let ctx = WhisperContext::new_with_params(model_path, WhisperContextParameters::default())?;
        Ok(Self { ctx: Arc::new(ctx) })
    }

    pub fn transcribe(&self, pcm_bytes: &[u8]) -> Result<String> {
        if pcm_bytes.is_empty() {
            return Ok(String::new());
        }
        let samples = s16le_to_f32(pcm_bytes);
        let mut state = self.ctx.create_state()?;
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some("en"));
        params.set_print_realtime(false);
        params.set_print_progress(false);
        params.set_n_threads(4);
        state.full(params, &samples)?;
        let n = state.full_n_segments()?;
        let mut text = String::new();
        for i in 0..n {
            let seg = state.full_get_segment_text(i)?.trim().to_string();
            if !seg.is_empty() {
                if !text.is_empty() {
                    text.push(' ');
                }
                text.push_str(&seg);
            }
        }
        Ok(text)
    }
}

/// Convert raw PCM bytes (16 kHz, signed 16-bit little-endian, mono) to
/// normalized f32 samples in [-1.0, 1.0] as expected by whisper.cpp.
pub fn s16le_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_maps_to_zero() {
        assert_eq!(s16le_to_f32(&[0, 0]), vec![0.0f32]);
    }

    #[test]
    fn positive_max_maps_near_one() {
        let result = s16le_to_f32(&32767i16.to_le_bytes());
        assert!((result[0] - (32767.0f32 / 32768.0)).abs() < 1e-6);
    }

    #[test]
    fn negative_min_maps_to_minus_one() {
        let result = s16le_to_f32(&(-32768i16).to_le_bytes());
        assert!((result[0] - (-1.0f32)).abs() < 1e-6);
    }

    #[test]
    fn empty_input_returns_empty() {
        assert!(s16le_to_f32(&[]).is_empty());
    }

    #[test]
    fn trailing_odd_byte_is_ignored() {
        // 3 bytes: first 2 form one sample, trailing byte is dropped by chunks_exact
        let mut bytes = 16384i16.to_le_bytes().to_vec();
        bytes.push(0xFF);
        let result = s16le_to_f32(&bytes);
        assert_eq!(result.len(), 1);
        assert!((result[0] - (16384.0f32 / 32768.0)).abs() < 1e-6);
    }

    #[test]
    fn correct_sample_count_for_multiple_samples() {
        let bytes: Vec<u8> = (0i16..10).flat_map(|i| (i * 100).to_le_bytes()).collect();
        assert_eq!(s16le_to_f32(&bytes).len(), 10);
    }

    #[test]
    fn little_endian_byte_order_is_respected() {
        // 0x0100 in LE = bytes [0x00, 0x01] = i16 value 256
        let result = s16le_to_f32(&[0x00, 0x01]);
        assert!((result[0] - (256.0f32 / 32768.0)).abs() < 1e-6);
    }

    #[test]
    fn new_returns_error_for_missing_model() {
        assert!(WhisperTranscriber::new("/nonexistent/ggml.bin").is_err());
    }
}
