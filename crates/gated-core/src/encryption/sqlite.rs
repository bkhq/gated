use anyhow::{Result, ensure};
use sea_orm::ConnectOptions;

pub fn make_connect_options(url: &str, dek_hex: &str) -> Result<ConnectOptions> {
    ensure!(dek_hex.len() == 64, "SQLCipher DEK must be 32 bytes as hex");
    ensure!(
        dek_hex.as_bytes().iter().all(u8::is_ascii_hexdigit),
        "SQLCipher DEK must be hex encoded"
    );
    let mut opt = ConnectOptions::new(url.to_owned());
    opt.sqlcipher_key(format!("\"x'{dek_hex}'\""));
    Ok(opt)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_sqlcipher_connect_options() {
        let opt = make_connect_options("sqlite:/tmp/gated.db", &"ab".repeat(32)).unwrap();
        assert!(format!("{opt:?}").contains("sqlite:/tmp/gated.db"));
    }

    #[test]
    fn rejects_invalid_hex_key() {
        assert!(make_connect_options("sqlite:/tmp/gated.db", "not-hex").is_err());
        assert!(make_connect_options("sqlite:/tmp/gated.db", &"zz".repeat(32)).is_err());
    }
}
