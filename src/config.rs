use serde::Deserialize;
use std::collections::HashMap;

#[derive(Debug, Deserialize, Clone)]
pub struct Config {
    pub matrix: MatrixConfig,
    pub rooms: HashMap<String, String>, // alias → room_id
    pub g2: G2Config,
}

#[derive(Debug, Deserialize, Clone)]
pub struct MatrixConfig {
    pub homeserver: String,
    pub user_id: String,
    pub token: String,
}

#[derive(Debug, Deserialize, Clone)]
pub struct G2Config {
    pub port: u16,
    pub token: String,
}

impl Config {
    pub fn load(path: &str) -> anyhow::Result<Self> {
        let text = std::fs::read_to_string(path)?;
        Ok(toml::from_str(&text)?)
    }
}
