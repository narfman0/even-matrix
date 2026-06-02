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
