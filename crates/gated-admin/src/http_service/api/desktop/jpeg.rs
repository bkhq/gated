//! Encoding of framebuffer regions for the viewer.

use image::ExtendedColorType;
use image::codecs::jpeg::JpegEncoder;

/// High, so that text stays readable. The encoder does not subsample chroma.
const QUALITY: u8 = 90;

/// A region with fewer raw bytes than this is sent as it is: the JPEG headers
/// alone would make it larger. 4 KiB is a 32x32 region.
pub(super) const MIN_ENCODE_BYTES: usize = 4096;

/// JPEG of an RGBA region; `None` when `rgba` does not match the size.
pub(super) fn encode_rgba(width: u32, height: u32, rgba: &[u8]) -> Option<Vec<u8>> {
    // JPEG dimensions are 16 bits.
    u16::try_from(width).ok()?;
    u16::try_from(height).ok()?;
    let pixels = usize::try_from(width)
        .ok()?
        .checked_mul(usize::try_from(height).ok()?)?;
    if pixels == 0 || rgba.len() != pixels.checked_mul(4)? {
        return None;
    }
    // The encoder takes no alpha channel.
    let mut rgb = Vec::with_capacity(pixels * 3);
    for pixel in rgba.chunks_exact(4) {
        if let [red, green, blue, _] = *pixel {
            rgb.extend_from_slice(&[red, green, blue]);
        }
    }
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, QUALITY)
        .encode(&rgb, width, height, ExtendedColorType::Rgb8)
        .ok()?;
    Some(out)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use gated_core::framebuffer::decode_jpeg_rgb;

    use super::*;

    #[test]
    fn keeps_the_channel_order() {
        let red: Vec<u8> = [255u8, 0, 0, 255].repeat(64 * 64);
        let jpeg = encode_rgba(64, 64, &red).unwrap();
        assert_eq!(&jpeg[..2], &[0xff, 0xd8]);
        assert!(jpeg.len() < red.len());

        let (width, height, rgb) = decode_jpeg_rgb(&jpeg).unwrap();
        assert_eq!((width, height), (64, 64));
        assert!(rgb[0] > 200 && rgb[2] < 60, "got {:?}", &rgb[..3]);
    }

    #[test]
    fn rejects_a_buffer_that_does_not_match_the_size() {
        assert!(encode_rgba(64, 64, &[0; 64 * 64 * 4 - 1]).is_none());
        assert!(encode_rgba(0, 0, &[]).is_none());
        assert!(encode_rgba(70_000, 1, &[0; 4]).is_none());
    }
}
