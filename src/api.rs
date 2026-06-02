use crate::{matrix::MatrixClient, session::SessionState};
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
pub type SharedMatrix = Arc<MatrixClient>;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    Transcript { text: String },
    ListRooms,
    SelectRoom { room_id: String },
    Ping,
}

#[derive(Debug, Clone, Serialize)]
pub struct RoomInfo {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HistMsg {
    pub sender: String,
    pub text: String,
    pub ts: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerEvent {
    Message {
        room_id: String,
        room_alias: String,
        sender: String,
        text: String,
        ts: u64,
    },
    Status {
        text: String,
    },
    RoomList {
        rooms: Vec<RoomInfo>,
    },
    History {
        room_id: String,
        messages: Vec<HistMsg>,
    },
    Pong,
}

pub fn router(state: SharedState, tx: EventTx, matrix: SharedMatrix) -> Router {
    Router::new()
        .route("/ws", get(ws_handler))
        .with_state((state, tx, matrix))
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State((state, tx, matrix)): State<(SharedState, EventTx, SharedMatrix)>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state, tx, matrix))
}

async fn handle_socket(
    socket: WebSocket,
    state: SharedState,
    tx: EventTx,
    matrix: SharedMatrix,
) {
    let (mut sink, mut stream) = socket.split();
    let mut rx = tx.subscribe();

    let forward = tokio::spawn(async move {
        while let Ok(ev) = rx.recv().await {
            let json = serde_json::to_string(&ev).unwrap_or_default();
            if sink.send(Message::Text(json.into())).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = stream.next().await {
        if let Message::Text(text) = msg {
            match serde_json::from_str::<ClientMsg>(&text) {
                Ok(ClientMsg::Transcript { text: transcript }) => {
                    info!("Transcript: {transcript}");
                    let _ = tx.send(ServerEvent::Status {
                        text: format!("Heard: {transcript}"),
                    });
                    state.lock().await.last_transcript = Some(transcript);
                }
                Ok(ClientMsg::ListRooms) => {
                    let rooms = matrix
                        .list_rooms()
                        .into_iter()
                        .map(|(id, name)| RoomInfo { id, name })
                        .collect();
                    let _ = tx.send(ServerEvent::RoomList { rooms });
                }
                Ok(ClientMsg::SelectRoom { room_id }) => {
                    state.lock().await.selected_room = Some(room_id.clone());
                    let messages = state
                        .lock()
                        .await
                        .messages_for_room(&room_id)
                        .into_iter()
                        .map(|m| HistMsg {
                            sender: m.sender.clone(),
                            text: m.text.clone(),
                            ts: m.ts,
                        })
                        .collect();
                    let _ = tx.send(ServerEvent::History { room_id, messages });
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
