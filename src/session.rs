#[derive(Debug, Default)]
pub struct SessionState {
    /// Pending transcript from the WS handler, consumed by the dispatch loop.
    pub last_transcript: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(alias: &str, sender: &str, text: &str) -> Message {
        Message {
            room_alias: alias.to_string(),
            sender: sender.to_string(),
            text: text.to_string(),
            ts: 0,
        }
    }

    #[test]
    fn push_message_caps_at_max_history() {
        let mut s = SessionState::default();
        for i in 0..=MAX_HISTORY + 2 {
            s.push_message(msg("room", "alice", &format!("msg {i}")));
        }
        assert_eq!(s.history.len(), MAX_HISTORY);
    }

    #[test]
    fn push_message_evicts_oldest() {
        let mut s = SessionState::default();
        for i in 0..MAX_HISTORY {
            s.push_message(msg("room", "alice", &format!("msg {i}")));
        }
        s.push_message(msg("room", "alice", "newest"));
        assert_eq!(s.history.front().unwrap().text, "msg 1");
        assert_eq!(s.history.back().unwrap().text, "newest");
    }

    #[test]
    fn messages_for_focused_filters_by_room() {
        let mut s = SessionState::default();
        s.focused_room = Some("wife".to_string());
        s.push_message(msg("wife", "alice", "hello"));
        s.push_message(msg("work", "bob", "standup"));
        s.push_message(msg("wife", "alice", "world"));
        let focused = s.messages_for_focused();
        assert_eq!(focused.len(), 2);
        assert_eq!(focused[0].text, "hello");
        assert_eq!(focused[1].text, "world");
    }

    #[test]
    fn messages_for_focused_returns_all_when_no_focus() {
        let mut s = SessionState::default();
        s.push_message(msg("wife", "alice", "a"));
        s.push_message(msg("work", "bob", "b"));
        assert_eq!(s.messages_for_focused().len(), 2);
    }

    #[test]
    fn cycle_room_wraps_around() {
        let mut s = SessionState::default();
        s.rooms = vec!["wife".to_string(), "work".to_string(), "default".to_string()];
        s.focused_room = Some("default".to_string());
        s.cycle_room();
        assert_eq!(s.focused_room.as_deref(), Some("wife")); // wraps to first
    }

    #[test]
    fn cycle_room_from_none_picks_first() {
        let mut s = SessionState::default();
        s.rooms = vec!["wife".to_string(), "work".to_string()];
        s.cycle_room();
        assert_eq!(s.focused_room.as_deref(), Some("wife"));
    }

    #[test]
    fn cycle_room_empty_is_noop() {
        let mut s = SessionState::default();
        s.cycle_room(); // should not panic
        assert!(s.focused_room.is_none());
    }
}
