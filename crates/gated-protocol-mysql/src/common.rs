use gated_common::ProtocolName;
use sha1::Digest as _;
use sha2::Sha256;

pub const PROTOCOL_NAME: ProtocolName = "MySQL";

pub fn compute_auth_challenge_response(
    challenge: [u8; 20],
    password: &str,
) -> Result<password_hash::Output, password_hash::Error> {
    password_hash::Output::new(
        &{
            let password_sha: [u8; 20] = sha1::Sha1::digest(password).into();
            let password_sha_sha: [u8; 20] = sha1::Sha1::digest(password_sha).into();
            let password_seed_2sha_sha: [u8; 20] =
                sha1::Sha1::digest([challenge, password_sha_sha].concat()).into();

            let mut result = password_sha;
            result
                .iter_mut()
                .zip(password_seed_2sha_sha.iter())
                .for_each(|(x1, x2)| *x1 ^= *x2);
            result
        }[..],
    )
}

/// caching_sha2_password scramble:
/// XOR(SHA256(password), SHA256(SHA256(SHA256(password)) || nonce))
pub fn compute_caching_sha2_response(nonce: &[u8], password: &str) -> [u8; 32] {
    let sha_pw: [u8; 32] = Sha256::digest(password.as_bytes()).into();
    let sha_sha_pw: [u8; 32] = Sha256::digest(sha_pw).into();
    let mut hasher = Sha256::new();
    hasher.update(sha_sha_pw);
    hasher.update(nonce);
    let scrambled: [u8; 32] = hasher.finalize().into();
    let mut out = sha_pw;
    for (b, s) in out.iter_mut().zip(scrambled.iter()) {
        *b ^= *s;
    }
    out
}

/// Build the byte payload the caching_sha2_password full-auth flow RSA-encrypts:
/// (password bytes followed by NUL) XOR cycled nonce.
pub fn xor_password_with_nonce(password: &str, nonce: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(password.len() + 1);
    buf.extend_from_slice(password.as_bytes());
    buf.push(0);
    if !nonce.is_empty() {
        for (i, b) in buf.iter_mut().enumerate() {
            if let Some(n) = nonce.get(i % nonce.len()) {
                *b ^= *n;
            }
        }
    }
    buf
}
