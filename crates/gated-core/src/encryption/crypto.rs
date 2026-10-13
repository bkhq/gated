use anyhow::{anyhow, ensure, Context, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use base64ct::{Base64, Encoding};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use password_hash::Output;
use rand_core::{OsRng, RngCore};
use secrecy::{ExposeSecret, SecretBox, SecretString};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

pub const DEK_AAD: &[u8] = b"gated:dek:v1";
const VERIFIER_KEY_AAD: &[u8] = b"gated:verifier:key:v1";
const VERIFIER_AAD: &[u8] = b"gated:verifier:v1";
const VERIFIER_KEY_NONCE: [u8; 12] = *b"gated-vkey01";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct KdfParams {
    pub m_cost_kib: u32,
    pub t_cost: u32,
    pub p_cost: u32,
}

impl Default for KdfParams {
    fn default() -> Self {
        Self {
            m_cost_kib: 262_144,
            t_cost: 3,
            p_cost: 1,
        }
    }
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
pub struct WrappedDek {
    pub alg: String,
    pub nonce: String,
    pub ciphertext: String,
    pub aad: String,
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
pub struct Verifier {
    pub alg: String,
    pub nonce: String,
    pub ciphertext: String,
    pub aad: String,
}

pub fn generate_salt() -> [u8; 32] {
    let mut salt = [0_u8; 32];
    OsRng.fill_bytes(&mut salt);
    salt
}

pub fn generate_dek() -> SecretBox<[u8; 32]> {
    let mut dek = Zeroizing::new([0_u8; 32]);
    OsRng.fill_bytes(dek.as_mut_slice());
    SecretBox::init_with(|| *dek)
}

pub fn derive_kek(
    password: &SecretString,
    salt: &[u8],
    params: &KdfParams,
) -> Result<SecretBox<[u8; 32]>> {
    ensure!(salt.len() == 32, "invalid KDF salt length");
    let argon_params = Params::new(params.m_cost_kib, params.t_cost, params.p_cost, Some(32))
        .map_err(|error| anyhow!("invalid Argon2id parameters: {error}"))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, argon_params);
    let mut output = Zeroizing::new([0_u8; 32]);
    argon2
        .hash_password_into(
            password.expose_secret().as_bytes(),
            salt,
            output.as_mut_slice(),
        )
        .map_err(|error| anyhow!("Argon2id key derivation failed: {error}"))?;

    Ok(SecretBox::init_with(|| *output))
}

pub fn wrap_dek(kek: &[u8; 32], dek: &SecretBox<[u8; 32]>, aad: &[u8]) -> Result<WrappedDek> {
    let mut nonce = [0_u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(kek));
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: dek.expose_secret(),
                aad,
            },
        )
        .map_err(|_| anyhow!("DEK wrap failed"))?;

    Ok(WrappedDek {
        alg: "ChaCha20-Poly1305".to_owned(),
        nonce: Base64::encode_string(&nonce),
        ciphertext: Base64::encode_string(&ciphertext),
        aad: String::from_utf8(aad.to_vec()).context("DEK AAD must be UTF-8")?,
    })
}

pub fn unwrap_dek(kek: &[u8; 32], wrapped: &WrappedDek, aad: &[u8]) -> Result<SecretBox<[u8; 32]>> {
    ensure!(
        wrapped.alg == "ChaCha20-Poly1305",
        "unsupported DEK wrap algorithm"
    );
    ensure!(wrapped.aad.as_bytes() == aad, "unexpected DEK wrap AAD");

    let nonce = decode_array::<12>(&wrapped.nonce).context("invalid DEK nonce")?;
    let ciphertext = Base64::decode_vec(&wrapped.ciphertext).context("invalid DEK ciphertext")?;
    let cipher = ChaCha20Poly1305::new(Key::from_slice(kek));
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: ciphertext.as_slice(),
                    aad,
                },
            )
            .map_err(|_| anyhow!("DEK unwrap failed"))?,
    );

    ensure!(plaintext.len() == 32, "invalid DEK length");
    let mut dek = [0_u8; 32];
    dek.copy_from_slice(&plaintext);
    Ok(SecretBox::init_with(|| dek))
}

pub fn make_verifier(kek: &[u8; 32]) -> Result<Verifier> {
    let verifier_key = derive_verifier_key(kek)?;
    let mut nonce = [0_u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(verifier_key.expose_secret()));
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &[],
                aad: VERIFIER_AAD,
            },
        )
        .map_err(|_| anyhow!("verifier creation failed"))?;

    Ok(Verifier {
        alg: "ChaCha20-Poly1305".to_owned(),
        nonce: Base64::encode_string(&nonce),
        ciphertext: Base64::encode_string(&ciphertext),
        aad: String::from_utf8(VERIFIER_AAD.to_vec()).context("verifier AAD must be UTF-8")?,
    })
}

pub fn verify(kek: &[u8; 32], verifier: &Verifier) -> bool {
    if verifier.alg != "ChaCha20-Poly1305" || verifier.aad.as_bytes() != VERIFIER_AAD {
        return false;
    }

    let Ok(verifier_key) = derive_verifier_key(kek) else {
        return false;
    };
    let Ok(nonce) = decode_array::<12>(&verifier.nonce) else {
        return false;
    };
    let Ok(expected) = Base64::decode_vec(&verifier.ciphertext) else {
        return false;
    };
    let cipher = ChaCha20Poly1305::new(Key::from_slice(verifier_key.expose_secret()));
    let Ok(actual) = cipher.encrypt(
        Nonce::from_slice(&nonce),
        Payload {
            msg: &[],
            aad: VERIFIER_AAD,
        },
    ) else {
        return false;
    };

    let Ok(actual) = Output::new(actual.as_slice()) else {
        return false;
    };
    let Ok(expected) = Output::new(expected.as_slice()) else {
        return false;
    };

    actual == expected
}

fn derive_verifier_key(kek: &[u8; 32]) -> Result<SecretBox<[u8; 32]>> {
    let cipher = ChaCha20Poly1305::new(Key::from_slice(kek));
    let stream = Zeroizing::new(
        cipher
            .encrypt(
                Nonce::from_slice(&VERIFIER_KEY_NONCE),
                Payload {
                    msg: &[0_u8; 32],
                    aad: VERIFIER_KEY_AAD,
                },
            )
            .map_err(|_| anyhow!("verifier key derivation failed"))?,
    );
    let mut key = [0_u8; 32];
    key.copy_from_slice(
        stream
            .get(..32)
            .ok_or_else(|| anyhow!("invalid verifier key material"))?,
    );
    Ok(SecretBox::init_with(|| key))
}

pub fn decode_array<const N: usize>(encoded: &str) -> Result<[u8; N]> {
    let decoded = Base64::decode_vec(encoded).context("invalid base64")?;
    ensure!(decoded.len() == N, "invalid decoded length");
    let mut out = [0_u8; N];
    out.copy_from_slice(&decoded);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use secrecy::ExposeSecretMut;
    use zeroize::Zeroize;

    use super::*;

    fn test_params() -> KdfParams {
        KdfParams {
            m_cost_kib: 1024,
            t_cost: 1,
            p_cost: 1,
        }
    }

    #[test]
    fn kdf_is_consistent() {
        let password = SecretString::from("correct horse battery staple");
        let salt = [7_u8; 32];
        let first = derive_kek(&password, &salt, &test_params()).unwrap();
        let second = derive_kek(&password, &salt, &test_params()).unwrap();
        assert_eq!(first.expose_secret(), second.expose_secret());
    }

    #[test]
    fn wrap_unwrap_round_trip_and_wrong_key_fails() {
        let password = SecretString::from("master-password");
        let wrong_password = SecretString::from("wrong-password");
        let salt = [3_u8; 32];
        let kek = derive_kek(&password, &salt, &test_params()).unwrap();
        let wrong_kek = derive_kek(&wrong_password, &salt, &test_params()).unwrap();
        let dek = generate_dek();

        let wrapped = wrap_dek(kek.expose_secret(), &dek, DEK_AAD).unwrap();
        let unwrapped = unwrap_dek(kek.expose_secret(), &wrapped, DEK_AAD).unwrap();

        assert_eq!(dek.expose_secret(), unwrapped.expose_secret());
        assert!(unwrap_dek(wrong_kek.expose_secret(), &wrapped, DEK_AAD).is_err());
    }

    #[test]
    fn verifier_accepts_only_matching_password() {
        let salt = [9_u8; 32];
        let good = derive_kek(&SecretString::from("good"), &salt, &test_params()).unwrap();
        let bad = derive_kek(&SecretString::from("bad"), &salt, &test_params()).unwrap();
        let verifier = make_verifier(good.expose_secret()).unwrap();

        assert!(verify(good.expose_secret(), &verifier));
        assert!(!verify(bad.expose_secret(), &verifier));
    }

    #[test]
    fn secret_box_zeroizes_inner_key_material() {
        let mut secret = SecretBox::new(Box::new([42_u8; 32]));
        secret.zeroize();
        assert_eq!(secret.expose_secret_mut(), &[0_u8; 32]);
    }
}
