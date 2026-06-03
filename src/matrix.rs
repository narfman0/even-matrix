use crate::config::Config;
use crate::session::CachedMessage;
use anyhow::Result;
use matrix_sdk::{
    Client,
    config::SyncSettings,
    room::MessagesOptions,
    ruma::{
        OwnedRoomId,
        events::{
            AnySyncMessageLikeEvent, AnySyncTimelineEvent,
            room::message::{MessageType, RoomMessageEventContent},
        },
        UInt,
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

    /// Fetch up to `limit` most-recent messages from the homeserver for a room.
    /// Returns messages in chronological order (oldest first).
    pub async fn fetch_history(&self, room_id: &str, limit: u32) -> Result<Vec<CachedMessage>> {
        let id: OwnedRoomId = room_id.parse()?;
        let room = self
            .client
            .get_room(&id)
            .ok_or_else(|| anyhow::anyhow!("Room not joined: {room_id}"))?;

        let mut options = MessagesOptions::backward();
        options.limit = UInt::new(limit.min(50) as u64).unwrap_or(UInt::MAX);
        let resp = room.messages(options).await?;

        let mut msgs: Vec<CachedMessage> = resp
            .chunk
            .into_iter()
            .filter_map(|ev| {
                let event = ev.raw().deserialize().ok()?;
                match event {
                    AnySyncTimelineEvent::MessageLike(
                        AnySyncMessageLikeEvent::RoomMessage(msg),
                    ) => {
                        let orig = msg.as_original()?;
                        if let MessageType::Text(tc) = &orig.content.msgtype {
                            let ts = u64::from(orig.origin_server_ts.get()) / 1000;
                            Some(CachedMessage {
                                sender: orig.sender.to_string(),
                                text: tc.body.clone(),
                                ts,
                            })
                        } else {
                            None
                        }
                    }
                    _ => None,
                }
            })
            .collect();

        msgs.reverse(); // API returns newest-first; flip to oldest-first
        Ok(msgs)
    }

    pub fn sync_settings() -> SyncSettings {
        SyncSettings::default()
    }
}
