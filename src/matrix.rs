use crate::config::Config;
use anyhow::Result;
use matrix_sdk::{
    Client,
    config::SyncSettings,
    ruma::{
        OwnedRoomId,
        events::room::message::RoomMessageEventContent,
    },
};
use std::collections::HashMap;
use tracing::info;

pub struct MatrixClient {
    client: Client,
    /// alias → room_id (for config-defined aliases only)
    room_map: HashMap<String, OwnedRoomId>,
}

impl MatrixClient {
    pub async fn connect(cfg: &Config) -> Result<Self> {
        let client = Client::builder()
            .homeserver_url(&cfg.matrix.homeserver)
            .build()
            .await?;

        client
            .matrix_auth()
            .login_username(&cfg.matrix.user_id, &cfg.matrix.password)
            .initial_device_display_name("monocle")
            .send()
            .await?;

        let room_map: HashMap<String, OwnedRoomId> = cfg
            .rooms
            .iter()
            .filter_map(|(alias, id_str)| {
                id_str.parse::<OwnedRoomId>().ok().map(|id| (alias.clone(), id))
            })
            .collect();

        info!("Matrix connected as {}", cfg.matrix.user_id);
        Ok(Self { client, room_map })
    }

    /// Returns all joined rooms as (room_id, display_name) pairs.
    pub fn list_rooms(&self) -> Vec<(String, String)> {
        self.client
            .joined_rooms()
            .into_iter()
            .map(|room| {
                let id = room.room_id().to_string();
                let name = room.name().unwrap_or_else(|| id.clone());
                (id, name)
            })
            .collect()
    }

    /// Send a message to a room by its ID directly.
    pub async fn send_to_room_id(&self, room_id: &str, message: &str) -> Result<()> {
        let id: OwnedRoomId = room_id.parse()?;
        let room = self
            .client
            .get_room(&id)
            .ok_or_else(|| anyhow::anyhow!("Room not joined: {room_id}"))?;
        room.send(RoomMessageEventContent::text_plain(message)).await?;
        info!("Sent to {room_id}: {message}");
        Ok(())
    }

    /// Send a message to a configured room alias.
    pub async fn send(&self, room_alias: &str, message: &str) -> Result<()> {
        let room_id = self
            .room_map
            .get(room_alias)
            .ok_or_else(|| anyhow::anyhow!("Unknown room alias: {room_alias}"))?;
        self.send_to_room_id(room_id.as_str(), message).await
    }

    pub fn default_room_id(&self) -> Option<String> {
        self.room_map.values().next().map(|id| id.to_string())
    }

    pub fn client(&self) -> &Client {
        &self.client
    }

    pub fn sync_settings() -> SyncSettings {
        SyncSettings::default()
    }
}
