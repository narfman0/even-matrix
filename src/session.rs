use std::collections::{HashMap, VecDeque};

const MAX_HISTORY: usize = 100;

#[derive(Debug, Clone, serde::Serialize)]
pub struct CachedMessage {
    pub sender: String,
    pub text: String,
    pub ts: u64,
}

#[derive(Debug, Default)]
pub struct SessionState {
    /// Pending transcript from WS handler, consumed by dispatch loop.
    pub last_transcript: Option<String>,
    /// Room ID currently selected by the glasses client.
    pub selected_room: Option<String>,
    /// Per-room message cache populated by sync event handler.
    pub room_history: HashMap<String, VecDeque<CachedMessage>>,
}

impl SessionState {
    pub fn push_message(&mut self, room_id: &str, msg: CachedMessage) {
        let history = self.room_history.entry(room_id.to_string()).or_default();
        if history.len() >= MAX_HISTORY {
            history.pop_front();
        }
        history.push_back(msg);
    }

    pub fn messages_for_room(&self, room_id: &str) -> Vec<&CachedMessage> {
        self.room_history
            .get(room_id)
            .map(|h| h.iter().collect())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(sender: &str, text: &str) -> CachedMessage {
        CachedMessage { sender: sender.to_string(), text: text.to_string(), ts: 0 }
    }

    #[test]
    fn push_stores_single_message() {
        let mut s = SessionState::default();
        s.push_message("room-a", msg("Alice", "hi"));
        let msgs = s.messages_for_room("room-a");
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].sender, "Alice");
    }

    #[test]
    fn push_preserves_insertion_order() {
        let mut s = SessionState::default();
        s.push_message("r", msg("A", "first"));
        s.push_message("r", msg("B", "second"));
        let msgs = s.messages_for_room("r");
        assert_eq!(msgs[0].text, "first");
        assert_eq!(msgs[1].text, "second");
    }

    #[test]
    fn push_evicts_oldest_at_max_history() {
        let mut s = SessionState::default();
        for i in 0..=MAX_HISTORY {
            s.push_message("r", msg("X", &format!("msg-{i}")));
        }
        let msgs = s.messages_for_room("r");
        assert_eq!(msgs.len(), MAX_HISTORY);
        assert_eq!(msgs[0].text, "msg-1");
        assert_eq!(msgs[MAX_HISTORY - 1].text, format!("msg-{MAX_HISTORY}"));
    }

    #[test]
    fn messages_for_unknown_room_returns_empty() {
        let s = SessionState::default();
        assert!(s.messages_for_room("nobody").is_empty());
    }

    #[test]
    fn two_rooms_are_independent() {
        let mut s = SessionState::default();
        s.push_message("room-a", msg("A", "hello"));
        s.push_message("room-b", msg("B", "world"));
        assert_eq!(s.messages_for_room("room-a").len(), 1);
        assert_eq!(s.messages_for_room("room-b").len(), 1);
        assert_eq!(s.messages_for_room("room-a")[0].sender, "A");
        assert_eq!(s.messages_for_room("room-b")[0].sender, "B");
    }

    #[test]
    fn last_transcript_take_clears_value() {
        let mut s = SessionState::default();
        s.last_transcript = Some("hello".to_string());
        assert_eq!(s.last_transcript.take(), Some("hello".to_string()));
        assert!(s.last_transcript.is_none());
    }
}
