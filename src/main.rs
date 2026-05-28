mod config;
mod intent;
mod matrix;
mod session;
mod api;

use anyhow::Result;
use clap::Parser;
use matrix_sdk::{
    Room,
    ruma::events::room::message::{MessageType, OriginalSyncRoomMessageEvent},
};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::{broadcast, Mutex};
use tracing::info;

#[derive(Parser)]
#[command(name = "g2-matrix", about = "G2 glasses <-> Matrix orchestrator")]
struct Args {
    #[arg(short, long, default_value = "config.toml")]
    config: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();
    let args = Args::parse();
    let cfg = config::Config::load(&args.config)?;

    let matrix = matrix::MatrixClient::connect(&cfg).await?;
    let (tx, _) = broadcast::channel::<api::ServerEvent>(64);

    let state = Arc::new(Mutex::new(session::SessionState {
        focused_room: cfg.rooms.keys().next().cloned(),
        rooms: cfg.rooms.keys().cloned().collect(),
        ..Default::default()
    }));

    // Register Matrix message handler — clone what we need before wrapping matrix in Arc
    {
        let tx2 = tx.clone();
        // Build a plain HashMap<String,String> for alias lookup inside the handler
        // (avoids needing to share MatrixClient itself across the handler closure)
        let alias_map: HashMap<String, String> = cfg
            .rooms
            .iter()
            .map(|(alias, room_id)| (room_id.clone(), alias.clone()))
            .collect();

        matrix.client().add_event_handler(
            move |ev: OriginalSyncRoomMessageEvent, room: Room| {
                let tx3 = tx2.clone();
                let alias_map2 = alias_map.clone();
                async move {
                    if let MessageType::Text(tc) = ev.content.msgtype {
                        let room_id = room.room_id().as_str().to_string();
                        let room_alias = alias_map2
                            .get(&room_id)
                            .cloned()
                            .unwrap_or_else(|| room_id.clone());
                        let ts = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs();
                        let _ = tx3.send(api::ServerEvent::Message {
                            room_alias,
                            sender: ev.sender.to_string(),
                            text: tc.body,
                            ts,
                        });
                    }
                }
            },
        );
    }

    // Wrap the Matrix client in Arc so it can be shared with the intent dispatch task
    let matrix = Arc::new(matrix);

    // Intent dispatch loop — polls for pending transcripts from the WS handler
    {
        let state2 = Arc::clone(&state);
        let tx2 = tx.clone();
        let matrix2 = Arc::clone(&matrix);
        let default_room = cfg.rooms.keys().next().cloned().unwrap_or_default();

        tokio::spawn(async move {
            loop {
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

                let pending = {
                    let mut s = state2.lock().await;
                    s.last_transcript.take()
                };

                if let Some((intent_val, _raw)) = pending {
                    use intent::Intent;
                    match intent_val {
                        Intent::Send { room_alias, message } => {
                            match matrix2.send(&room_alias, &message).await {
                                Ok(_) => {
                                    let _ = tx2.send(api::ServerEvent::Status {
                                        text: format!("Sent to {room_alias}"),
                                    });
                                }
                                Err(e) => {
                                    let _ = tx2.send(api::ServerEvent::Status {
                                        text: format!("Error: {e}"),
                                    });
                                }
                            }
                        }
                        Intent::Reply { message } => {
                            let room = state2
                                .lock()
                                .await
                                .focused_room
                                .clone()
                                .unwrap_or_else(|| default_room.clone());
                            match matrix2.send(&room, &message).await {
                                Ok(_) => {
                                    let _ = tx2.send(api::ServerEvent::Status {
                                        text: format!("Replied in {room}"),
                                    });
                                }
                                Err(e) => {
                                    let _ = tx2.send(api::ServerEvent::Status {
                                        text: format!("Error: {e}"),
                                    });
                                }
                            }
                        }
                        Intent::Focus { room_alias } => {
                            state2.lock().await.focused_room = Some(room_alias.clone());
                            let _ = tx2.send(api::ServerEvent::Status {
                                text: format!("Now watching: {room_alias}"),
                            });
                        }
                        Intent::Check => {
                            let s = state2.lock().await;
                            let msgs = s.messages_for_focused();
                            let summary = msgs
                                .iter()
                                .rev()
                                .take(3)
                                .map(|m| format!("{}: {}", m.sender, m.text))
                                .collect::<Vec<_>>()
                                .join(" | ");
                            let _ = tx2.send(api::ServerEvent::Status {
                                text: if summary.is_empty() {
                                    "No messages".into()
                                } else {
                                    summary
                                },
                            });
                        }
                        Intent::Unknown(raw) => {
                            let _ = tx2.send(api::ServerEvent::Status {
                                text: format!("Unknown: {raw}"),
                            });
                        }
                    }
                }
            }
        });
    }

    // Start Matrix sync in background
    let sync_client = matrix.client().clone();
    tokio::spawn(async move {
        if let Err(e) = sync_client.sync(matrix::MatrixClient::sync_settings()).await {
            tracing::error!("Matrix sync error: {e}");
        }
    });

    // Start WebSocket API server
    let port = cfg.g2.port;
    let router = api::router(Arc::clone(&state), tx);
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}")).await?;
    info!("G2 API listening on port {port}");

    axum::serve(listener, router).await?;
    Ok(())
}
