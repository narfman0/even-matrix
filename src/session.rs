use std::collections::VecDeque;

const MAX_HISTORY: usize = 20;

#[derive(Debug, Clone, serde::Serialize)]
pub struct Message {
    pub room_alias: String,
    pub sender: String,
    pub text: String,
    pub ts: u64,
}

#[derive(Debug, Default)]
pub struct SessionState {
    pub focused_room: Option<String>,
    pub history: VecDeque<Message>,
    pub rooms: Vec<String>, // ordered list of aliases for cycling
    /// Pending intent dispatched from the WS handler to the main loop.
    pub last_transcript: Option<(crate::intent::Intent, String)>,
}

impl SessionState {
    pub fn push_message(&mut self, msg: Message) {
        if self.history.len() >= MAX_HISTORY {
            self.history.pop_front();
        }
        self.history.push_back(msg);
    }

    pub fn cycle_room(&mut self) {
        if self.rooms.is_empty() {
            return;
        }
        self.focused_room = match &self.focused_room {
            None => self.rooms.first().cloned(),
            Some(current) => {
                let idx = self.rooms.iter().position(|r| r == current).unwrap_or(0);
                self.rooms.get((idx + 1) % self.rooms.len()).cloned()
            }
        };
    }

    pub fn messages_for_focused(&self) -> Vec<&Message> {
        match &self.focused_room {
            None => self.history.iter().collect(),
            Some(alias) => self.history.iter().filter(|m| &m.room_alias == alias).collect(),
        }
    }
}
