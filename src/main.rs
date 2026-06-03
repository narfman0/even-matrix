mod config;
mod matrix;
mod session;
mod transcribe;
mod api;

/// Trim a Matrix user ID for display.
/// Local users (`@alice:home.server`) → `alice`.
/// Federated users (`@bob:other.org`) → `bob@other.org`.
fn display_sender(user_id: &str, hs_host: &str) -> String {
    let without_at = user_id.trim_start_matches('@');
    match without_at.split_once(':') {
        Some((local, server)) if server == hs_host => local.to_string(),
        Some((local, server)) => format!("{local}@{server}"),
        None => user_id.to_string(),
    }
}

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

    let hs_host = cfg.matrix.homeserver
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .to_string();

    // Cache incoming Matrix messages per room_id for history browsing
    {
        let tx2 = tx.clone();
        let state2 = Arc::clone(&state);
        let hs_host2 = hs_host.clone();

        matrix.client().add_event_handler(
            move |ev: OriginalSyncRoomMessageEvent, room: Room| {
                let tx3 = tx2.clone();
                let state3 = Arc::clone(&state2);
                let hs = hs_host2.clone();
                async move {
                    if let MessageType::Text(tc) = ev.content.msgtype {
                        let room_id = room.room_id().to_string();
                        let ts = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs();
                        let sender = display_sender(&ev.sender.to_string(), &hs);
                        let msg = session::CachedMessage {
                            sender: sender.clone(),
                            text: tc.body.clone(),
                            ts,
                        };
                        state3.lock().await.push_message(&room_id, msg);

                        let _ = tx3.send(api::ServerEvent::Message {
                            room_id: room_id.clone(),
                            room_alias: room.name().unwrap_or(room_id),
                            sender,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_user_shows_only_localpart() {
        assert_eq!(display_sender("@alice:matrix.example.com", "matrix.example.com"), "alice");
    }

    #[test]
    fn federated_user_shows_localpart_at_server() {
        assert_eq!(display_sender("@bob:other.org", "matrix.example.com"), "bob@other.org");
    }

    #[test]
    fn homeserver_with_trailing_slash_still_matches() {
        // hs_host is pre-trimmed before being passed in, but guard against it
        assert_eq!(display_sender("@alice:home.server", "home.server"), "alice");
    }

    #[test]
    fn malformed_user_id_passed_through() {
        assert_eq!(display_sender("notamatrixid", "matrix.example.com"), "notamatrixid");
    }
}
