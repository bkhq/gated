use std::str::from_utf8;

use bytes::{Buf, Bytes};
use memchr::memchr;

use crate::err_protocol;
use crate::error::Error;

pub trait BufExt: Buf {
    // Read a nul-terminated byte sequence
    fn get_bytes_nul(&mut self) -> Result<Bytes, Error>;

    // Read a byte sequence of the exact length
    fn get_bytes(&mut self, len: usize) -> Result<Bytes, Error>;

    // Read a nul-terminated string
    fn get_str_nul(&mut self) -> Result<String, Error>;

    // Read a string of the exact length
    fn get_str(&mut self, len: usize) -> Result<String, Error>;

    // Skip a byte sequence of the exact length
    fn skip(&mut self, len: usize) -> Result<(), Error>;
}

impl BufExt for Bytes {
    fn get_bytes_nul(&mut self) -> Result<Bytes, Error> {
        let nul =
            memchr(b'\0', self).ok_or_else(|| err_protocol!("expected NUL in byte sequence"))?;

        let v = self.slice(0..nul);

        self.advance(nul + 1);

        Ok(v)
    }

    fn get_bytes(&mut self, len: usize) -> Result<Bytes, Error> {
        if len > self.len() {
            return Err(err_protocol!(
                "expected {len} bytes but only {} remain in buffer",
                self.len()
            ));
        }

        let v = self.slice(..len);
        self.advance(len);

        Ok(v)
    }

    fn get_str_nul(&mut self) -> Result<String, Error> {
        self.get_bytes_nul().and_then(|bytes| {
            from_utf8(&bytes)
                .map(ToOwned::to_owned)
                .map_err(|err| err_protocol!("{}", err))
        })
    }

    fn get_str(&mut self, len: usize) -> Result<String, Error> {
        if len > self.len() {
            return Err(err_protocol!(
                "expected {len} bytes but only {} remain in buffer",
                self.len()
            ));
        }

        let v = from_utf8(&self[..len])
            .map_err(|err| err_protocol!("{}", err))
            .map(ToOwned::to_owned)?;

        self.advance(len);

        Ok(v)
    }

    fn skip(&mut self, len: usize) -> Result<(), Error> {
        if len > self.len() {
            return Err(err_protocol!(
                "expected {len} bytes but only {} remain in buffer",
                self.len()
            ));
        }

        self.advance(len);

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use bytes::Bytes;

    use super::BufExt;

    // Decoders must return an error (not panic) when a
    // length read from the wire exceeds the bytes that remain.
    #[test]
    fn get_bytes_rejects_oversized_len() {
        let mut buf = Bytes::from_static(b"abc");
        assert!(buf.get_bytes(10).is_err());
        // Buffer is left untouched on error.
        assert_eq!(&buf[..], b"abc");
    }

    #[test]
    fn get_bytes_reads_exact_len() {
        let mut buf = Bytes::from_static(b"abcdef");
        let v = buf.get_bytes(3).expect("len within bounds");
        assert_eq!(&v[..], b"abc");
        assert_eq!(&buf[..], b"def");
    }

    #[test]
    fn get_str_rejects_oversized_len() {
        let mut buf = Bytes::from_static(b"abc");
        assert!(buf.get_str(10).is_err());
        assert_eq!(&buf[..], b"abc");
    }
}
