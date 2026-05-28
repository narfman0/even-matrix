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

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
[matrix]
homeserver = "https://matrix.example.com"
user_id    = "@alice:example.com"
token      = "syt_test_token"

[rooms]
default = "!abc123:example.com"
wife    = "!def456:example.com"

[g2]
port  = 4000
token = "changeme"
"#;

    #[test]
    fn parses_valid_toml() {
        let cfg: Config = toml::from_str(SAMPLE).expect("should parse");
        assert_eq!(cfg.matrix.homeserver, "https://matrix.example.com");
        assert_eq!(cfg.matrix.user_id, "@alice:example.com");
        assert_eq!(cfg.g2.port, 4000);
        assert_eq!(cfg.rooms.get("default").map(|s| s.as_str()), Some("!abc123:example.com"));
        assert_eq!(cfg.rooms.get("wife").map(|s| s.as_str()), Some("!def456:example.com"));
    }

    #[test]
    fn missing_matrix_section_fails() {
        let bad = r#"
[rooms]
default = "!abc:example.com"
[g2]
port = 4000
token = "x"
"#;
        assert!(toml::from_str::<Config>(bad).is_err());
    }
}
