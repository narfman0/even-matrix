use serde::Deserialize;

#[derive(Debug, Deserialize, Clone)]
pub struct Config {
    pub matrix: MatrixConfig,
    pub g2: G2Config,
}

#[derive(Debug, Deserialize, Clone)]
pub struct MatrixConfig {
    pub homeserver: String,
    pub user_id: String,
    pub password: String,
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
password   = "hunter2"

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
    }

    #[test]
    fn missing_matrix_section_fails() {
        let bad = r#"
[g2]
port = 4000
token = "x"
"#;
        assert!(toml::from_str::<Config>(bad).is_err());
    }
}
