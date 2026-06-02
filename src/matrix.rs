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
use tracing::info;

pub struct MatrixClient {
    client: Client,
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

        // Populate the room cache before accepting any connections.
        client.sync_once(SyncSettings::default()).await?;

        info!("Matrix connected as {}", cfg.matrix.user_id);
        Ok(Self { client })
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

    /// Returns the first joined room's ID as the default for voice sends.
    pub fn default_room_id(&self) -> Option<String> {
        self.client
            .joined_rooms()
            .into_iter()
            .next()
            .map(|r| r.room_id().to_string())
    }

    /// Send a message to a room by its ID.
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

    pub fn client(&self) -> &Client {
        &self.client
    }

    pub fn sync_settings() -> SyncSettings {
        SyncSettings::default()
    }
}
