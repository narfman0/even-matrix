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
    /// alias → room_id
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

    pub async fn send(&self, room_alias: &str, message: &str) -> Result<()> {
        let room_id = self
            .room_map
            .get(room_alias)
            .ok_or_else(|| anyhow::anyhow!("Unknown room alias: {room_alias}"))?;

        let room = self
            .client
            .get_room(room_id)
            .ok_or_else(|| anyhow::anyhow!("Room not joined: {room_id}"))?;

        room.send(RoomMessageEventContent::text_plain(message)).await?;
        info!("Sent to {room_alias}: {message}");
        Ok(())
    }

    pub fn room_alias_for_id(&self, room_id: &str) -> Option<&str> {
        self.room_map
            .iter()
            .find(|(_, id)| id.as_str() == room_id)
            .map(|(alias, _)| alias.as_str())
    }

    pub fn client(&self) -> &Client {
        &self.client
    }

    pub fn room_map(&self) -> &HashMap<String, OwnedRoomId> {
        &self.room_map
    }

    pub fn sync_settings() -> SyncSettings {
        SyncSettings::default()
    }
}
