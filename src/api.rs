use crate::{matrix::MatrixClient, session::SessionState, transcribe::WhisperTranscriber};
use tower_http::cors::CorsLayer;
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
pub type SharedWhisper = Option<Arc<WhisperTranscriber>>;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    Transcript { text: String },
    ListRooms,
    SelectRoom { room_id: String },
    AudioStart,
    AudioEnd,
    Ping,
}

#[derive(Debug, Clone, Serialize)]
pub struct RoomInfo {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SpaceInfo {
    pub id: String,
    pub name: String,
    pub rooms: Vec<RoomInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RoomHierarchy {
    pub dms: Vec<RoomInfo>,
    pub spaces: Vec<SpaceInfo>,
    pub orphans: Vec<RoomInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HistMsg {
    pub event_id: String,
    pub sender: String,
    pub text: String,
    pub ts: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerEvent {
    Message {
        event_id: String,
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
        hierarchy: RoomHierarchy,
    },
    History {
        room_id: String,
        messages: Vec<HistMsg>,
    },
    Pong,
}

pub fn router(state: SharedState, tx: EventTx, matrix: SharedMatrix, whisper: SharedWhisper) -> Router {
    Router::new()
        .route("/ws", get(ws_handler))
        .layer(CorsLayer::permissive())
        .with_state((state, tx, matrix, whisper))
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State((state, tx, matrix, whisper)): State<(SharedState, EventTx, SharedMatrix, SharedWhisper)>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state, tx, matrix, whisper))
}

async fn handle_socket(
    socket: WebSocket,
    state: SharedState,
    tx: EventTx,
    matrix: SharedMatrix,
    whisper: SharedWhisper,
) {
    let (mut sink, mut stream) = socket.split();
    let mut rx = tx.subscribe();
    let mut audio_buf: Vec<u8> = Vec::new();

    let forward = tokio::spawn(async move {
        while let Ok(ev) = rx.recv().await {
            let json = serde_json::to_string(&ev).unwrap_or_default();
            if sink.send(Message::Text(json.into())).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(text) => {
                match serde_json::from_str::<ClientMsg>(&text) {
                    Ok(ClientMsg::AudioStart) => {
                        audio_buf.clear();
                    }
                    Ok(ClientMsg::AudioEnd) => {
                        match &whisper {
                            Some(w) => {
                                let bytes = std::mem::take(&mut audio_buf);
                                let w = Arc::clone(w);
                                let tx2 = tx.clone();
                                let state2 = Arc::clone(&state);
                                tokio::spawn(async move {
                                    let result = tokio::task::spawn_blocking(move || {
                                        w.transcribe(&bytes)
                                    })
                                    .await;
                                    match result {
                                        Ok(Ok(t)) if !t.is_empty() => {
                                            let _ = tx2.send(ServerEvent::Status {
                                                text: format!("Heard: {t}"),
                                            });
                                            state2.lock().await.last_transcript = Some(t);
                                        }
                                        Ok(Ok(_)) => {
                                            let _ = tx2.send(ServerEvent::Status {
                                                text: "Nothing heard".into(),
                                            });
                                        }
                                        Ok(Err(e)) => {
                                            warn!("Transcription error: {e}");
                                            let _ = tx2.send(ServerEvent::Status {
                                                text: "Transcription failed".into(),
                                            });
                                        }
                                        Err(e) => warn!("Transcription task panicked: {e}"),
                                    }
                                });
                            }
                            None => {
                                let _ = tx.send(ServerEvent::Status {
                                    text: "No whisper model configured".into(),
                                });
                            }
                        }
                    }
                    Ok(ClientMsg::Transcript { text: transcript }) => {
                        info!("Transcript: {transcript}");
                        let _ = tx.send(ServerEvent::Status {
                            text: format!("Heard: {transcript}"),
                        });
                        state.lock().await.last_transcript = Some(transcript);
                    }
                    Ok(ClientMsg::ListRooms) => {
                        let hierarchy = matrix.list_rooms_hierarchical().await;
                        let _ = tx.send(ServerEvent::RoomList { hierarchy });
                    }
                    Ok(ClientMsg::SelectRoom { room_id }) => {
                        state.lock().await.selected_room = Some(room_id.clone());

                        // Respond from cache immediately so the UI transitions at once.
                        let mut cached: Vec<HistMsg> = state
                            .lock()
                            .await
                            .messages_for_room(&room_id)
                            .into_iter()
                            .map(|m| HistMsg {
                                event_id: m.event_id.clone(),
                                sender: m.sender.clone(),
                                text: m.text.clone(),
                                ts: m.ts,
                            })
                            .collect();
                        cached.sort_by_key(|m| m.ts);
                        let _ = tx.send(ServerEvent::History { room_id: room_id.clone(), messages: cached });

                        // Fetch full history from the homeserver in the background and
                        // send a second History update if we get more/different messages.
                        let tx2 = tx.clone();
                        let matrix2 = Arc::clone(&matrix);
                        let room_id2 = room_id.clone();
                        tokio::spawn(async move {
                            match matrix2.fetch_history(&room_id2, 50).await {
                                Ok(mut fetched) => {
                                    fetched.sort_by_key(|m| m.ts);
                                    let messages = fetched
                                        .into_iter()
                                        .map(|m| HistMsg { event_id: m.event_id, sender: m.sender, text: m.text, ts: m.ts })
                                        .collect();
                                    let _ = tx2.send(ServerEvent::History { room_id: room_id2, messages });
                                }
                                Err(e) => warn!("fetch_history failed: {e}"),
                            }
                        });
                    }
                    Ok(ClientMsg::Ping) => {
                        let _ = tx.send(ServerEvent::Pong);
                    }
                    Err(e) => warn!("Bad client msg: {e}"),
                }
            }
            Message::Binary(bytes) => {
                audio_buf.extend_from_slice(&bytes);
            }
            _ => {}
        }
    }

    forward.abort();
}
