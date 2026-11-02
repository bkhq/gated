use std::ops::{Deref, DerefMut};

use bytes::Bytes;

use crate::io::Encode;
use crate::mysql::protocol::Capabilities;

#[derive(Debug)]
pub struct Packet<T>(pub T);

impl<'en, 'stream, T> Encode<'stream, (Capabilities, &'stream mut u8)> for Packet<T>
where
    T: Encode<'en, Capabilities>,
{
    fn encode_with(
        &self,
        buf: &mut Vec<u8>,
        (capabilities, sequence_id): (Capabilities, &'stream mut u8),
    ) {
        // reserve space to write the prefixed length
        let offset = buf.len();
        buf.extend([0_u8; 4]);

        // encode the payload
        self.0.encode_with(buf, capabilities);

        // determine the length of the encoded payload
        // and write to our reserved space
        let len = buf.len() - offset - 4;

        // Packets of 16 MiB or more are not supported.
        assert!(len < 0xFF_FF_FF);

        let [len_0, len_1, len_2, _] = (len as u32).to_le_bytes();
        if let Some(header) = buf.get_mut(offset..offset + 4) {
            header.copy_from_slice(&[len_0, len_1, len_2, *sequence_id]);
        }

        *sequence_id = sequence_id.wrapping_add(1);
    }
}

impl Deref for Packet<Bytes> {
    type Target = Bytes;

    fn deref(&self) -> &Bytes {
        &self.0
    }
}

impl DerefMut for Packet<Bytes> {
    fn deref_mut(&mut self) -> &mut Bytes {
        &mut self.0
    }
}
