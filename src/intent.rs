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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tell_parses_alias_and_message() {
        let i = parse("tell wife I'm on my way");
        match i {
            Intent::Send { room_alias, message } => {
                assert_eq!(room_alias, "wife");
                assert_eq!(message, "i'm on my way");
            }
            _ => panic!("expected Send"),
        }
    }

    #[test]
    fn tell_case_insensitive() {
        let i = parse("Tell Work Meeting in 5");
        match i {
            Intent::Send { room_alias, message } => {
                assert_eq!(room_alias, "work");
                assert_eq!(message, "meeting in 5");
            }
            _ => panic!("expected Send"),
        }
    }

    #[test]
    fn send_to_parses() {
        let i = parse("send to work server is down");
        match i {
            Intent::Send { room_alias, message } => {
                assert_eq!(room_alias, "work");
                assert_eq!(message, "server is down");
            }
            _ => panic!("expected Send"),
        }
    }

    #[test]
    fn reply_parses() {
        let i = parse("reply sounds good");
        match i {
            Intent::Reply { message } => assert_eq!(message, "sounds good"),
            _ => panic!("expected Reply"),
        }
    }

    #[test]
    fn switch_to_parses() {
        let i = parse("switch to wife");
        match i {
            Intent::Focus { room_alias } => assert_eq!(room_alias, "wife"),
            _ => panic!("expected Focus"),
        }
    }

    #[test]
    fn focus_parses() {
        let i = parse("focus work");
        match i {
            Intent::Focus { room_alias } => assert_eq!(room_alias, "work"),
            _ => panic!("expected Focus"),
        }
    }

    #[test]
    fn check_keywords() {
        for phrase in &["check messages", "what did she say", "any messages"] {
            match parse(phrase) {
                Intent::Check => {}
                other => panic!("expected Check for {:?}, got {:?}", phrase, other),
            }
        }
    }

    #[test]
    fn unknown_fallback() {
        match parse("hello world") {
            Intent::Unknown(_) => {}
            other => panic!("expected Unknown, got {:?}", other),
        }
    }

    #[test]
    fn tell_single_word_only_alias_is_unknown() {
        // "tell wife" with no message — should not panic, falls through to Unknown
        match parse("tell wife") {
            Intent::Unknown(_) => {}
            // Some implementations might return Send with empty message — also acceptable
            Intent::Send { .. } => {}
            other => panic!("unexpected: {:?}", other),
        }
    }
}
