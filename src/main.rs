mod config;
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

    let matrix = matrix::MatrixClient::connect(&cfg).await?;
    let (tx, _) = broadcast::channel::<api::ServerEvent>(64);

    let state = Arc::new(Mutex::new(session::SessionState::default()));

    // Register Matrix message handler
    {
        let tx2 = tx.clone();
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

    let matrix = Arc::new(matrix);

    // Dispatch loop — sends every transcript as-is to the default room
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

                if let Some(text) = pending {
                    match matrix2.send(&default_room, &text).await {
                        Ok(_) => {
                            let _ = tx2.send(api::ServerEvent::Status {
                                text: "Sent".into(),
                            });
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
