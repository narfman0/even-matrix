mod config;
mod matrix;
mod session;
mod transcribe;
mod api;

use anyhow::Result;
use clap::Parser;
use matrix_sdk::{
    Room,
    ruma::events::room::message::{MessageType, OriginalSyncRoomMessageEvent},
};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::{broadcast, Mutex};
use tracing::info;

#[derive(Parser)]
#[command(name = "monocle", about = "Smart glasses <-> Matrix orchestrator")]
struct Args {
    #[arg(short, long, default_value = "config.toml")]
    config: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();
    let args = Args::parse();
    let cfg = config::Config::load(&args.config)?;

    let matrix = Arc::new(matrix::MatrixClient::connect(&cfg).await?);
    let (tx, _) = broadcast::channel::<api::ServerEvent>(64);
    let state = Arc::new(Mutex::new(session::SessionState::default()));

    // Cache incoming Matrix messages per room_id for history browsing
    {
        let tx2 = tx.clone();
        let state2 = Arc::clone(&state);

        matrix.client().add_event_handler(
            move |ev: OriginalSyncRoomMessageEvent, room: Room| {
                let tx3 = tx2.clone();
                let state3 = Arc::clone(&state2);
                async move {
                    if let MessageType::Text(tc) = ev.content.msgtype {
                        let room_id = room.room_id().to_string();
                        let ts = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs();
                        let msg = session::CachedMessage {
                            sender: ev.sender.to_string(),
                            text: tc.body.clone(),
                            ts,
                        };
                        state3.lock().await.push_message(&room_id, msg);

                        let _ = tx3.send(api::ServerEvent::Message {
                            room_id: room_id.clone(),
                            room_alias: room.name().unwrap_or(room_id),
                            sender: ev.sender.to_string(),
                            text: tc.body,
                            ts,
                        });
                    }
                }
            },
        );
    }

    // Dispatch loop — sends transcripts to selected room (or default)
    {
        let state2 = Arc::clone(&state);
        let tx2 = tx.clone();
        let matrix2 = Arc::clone(&matrix);
        let default_room = matrix2.default_room_id().unwrap_or_default();

        tokio::spawn(async move {
            loop {
                tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

                let pending = {
                    let mut s = state2.lock().await;
                    s.last_transcript.take()
                };

                if let Some(text) = pending {
                    let room_id = state2
                        .lock()
                        .await
                        .selected_room
                        .clone()
                        .unwrap_or_else(|| default_room.clone());

                    match matrix2.send_to_room_id(&room_id, &text).await {
                        Ok(_) => {
                            let _ = tx2.send(api::ServerEvent::Status { text: "Sent".into() });
                        }
                        Err(e) => {
                            let _ = tx2.send(api::ServerEvent::Status {
                                text: format!("Error: {e}"),
                            });
                        }
                    }
                }
            }
        });
    }

    // Matrix sync in background
    let sync_client = matrix.client().clone();
    tokio::spawn(async move {
        if let Err(e) = sync_client.sync(matrix::MatrixClient::sync_settings()).await {
            tracing::error!("Matrix sync error: {e}");
        }
    });

    let whisper = cfg.whisper.as_ref().and_then(|w| {
        match transcribe::WhisperTranscriber::new(&w.model_path) {
            Ok(t) => {
                info!("Whisper model loaded from {}", w.model_path);
                Some(Arc::new(t))
            }
            Err(e) => {
                tracing::warn!("Could not load whisper model: {e}");
                None
            }
        }
    });

    let port = cfg.g2.port;
    let router = api::router(Arc::clone(&state), tx, Arc::clone(&matrix), whisper);
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}")).await?;
    info!("G2 API listening on port {port}");

    axum::serve(listener, router).await?;
    Ok(())
}
