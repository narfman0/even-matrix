use crate::{intent, session::SessionState};
use axum::{
    extract::{
        State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};
use tracing::{info, warn};

pub type SharedState = Arc<Mutex<SessionState>>;
pub type EventTx = broadcast::Sender<ServerEvent>;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    Transcript { text: String },
    Focus { room: String },
    Ping,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerEvent {
    Message {
        room_alias: String,
        sender: String,
        text: String,
        ts: u64,
    },
    Status {
        text: String,
    },
    Rooms {
        rooms: Vec<String>,
        focused: Option<String>,
    },
    Pong,
}

pub fn router(state: SharedState, tx: EventTx) -> Router {
    Router::new()
        .route("/ws", get(ws_handler))
        .with_state((state, tx))
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State((state, tx)): State<(SharedState, EventTx)>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state, tx))
}

async fn handle_socket(socket: WebSocket, state: SharedState, tx: EventTx) {
    let (mut sink, mut stream) = socket.split();
    let mut rx = tx.subscribe();

    // Forward broadcast events to the glasses
    let forward = tokio::spawn(async move {
        while let Ok(ev) = rx.recv().await {
            let json = serde_json::to_string(&ev).unwrap_or_default();
            if sink.send(Message::Text(json.into())).await.is_err() {
                break;
            }
        }
    });

    // Handle incoming messages from the glasses
    while let Some(Ok(msg)) = stream.next().await {
        if let Message::Text(text) = msg {
            match serde_json::from_str::<ClientMsg>(&text) {
                Ok(ClientMsg::Transcript { text: transcript }) => {
                    info!("Transcript: {transcript}");
                    let parsed = intent::parse(&transcript);
                    // Emit immediate status feedback to the glasses
                    let _ = tx.send(ServerEvent::Status {
                        text: format!("Heard: {transcript}"),
                    });
                    // Store pending intent for the dispatch loop to pick up
                    state.lock().await.last_transcript = Some((parsed, transcript));
                }
                Ok(ClientMsg::Focus { room }) => {
                    let mut s = state.lock().await;
                    s.focused_room = Some(room.clone());
                    let _ = tx.send(ServerEvent::Status {
                        text: format!("Focused: {room}"),
                    });
                }
                Ok(ClientMsg::Ping) => {
                    let _ = tx.send(ServerEvent::Pong);
                }
                Err(e) => warn!("Bad client msg: {e}"),
            }
        }
    }

    forward.abort();
}
