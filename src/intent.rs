/// Parsed intent from a voice transcript
#[derive(Debug, Clone)]
pub enum Intent {
    /// "tell wife I'm boarding" / "send to work meeting starting soon"
    Send { room_alias: String, message: String },
    /// "reply sounds good" / "reply on my way"
    Reply { message: String },
    /// "switch to wife" / "focus work"
    Focus { room_alias: String },
    /// "check messages" / "what did she say"
    Check,
    /// Unrecognized — echo back
    Unknown(String),
}

pub fn parse(transcript: &str) -> Intent {
    let s = transcript.trim().to_lowercase();

    // "tell <alias> <message>"
    if let Some(rest) = s.strip_prefix("tell ") {
        if let Some(sp) = rest.find(' ') {
            let alias = rest[..sp].to_string();
            let message = rest[sp + 1..].to_string();
            return Intent::Send { room_alias: alias, message };
        }
    }

    // "send to <alias> <message>"
    if let Some(rest) = s.strip_prefix("send to ") {
        if let Some(sp) = rest.find(' ') {
            let alias = rest[..sp].to_string();
            let message = rest[sp + 1..].to_string();
            return Intent::Send { room_alias: alias, message };
        }
    }

    // "reply <message>"
    if let Some(rest) = s.strip_prefix("reply ") {
        return Intent::Reply { message: rest.to_string() };
    }

    // "switch to <alias>" / "focus <alias>"
    for prefix in &["switch to ", "focus "] {
        if let Some(rest) = s.strip_prefix(prefix) {
            return Intent::Focus { room_alias: rest.trim().to_string() };
        }
    }

    // check / status queries
    if s.contains("check") || s.contains("what did") || s.contains("any messages") {
        return Intent::Check;
    }

    Intent::Unknown(transcript.to_string())
}
