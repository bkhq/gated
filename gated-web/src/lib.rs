use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../gated-web/dist"]
pub struct Assets;
