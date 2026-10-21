//! The voice a client carries: Opus in, Opus out, and the transport under it. The app becomes a window on every
//! platform with its voice in Rust while the browser tab stays a second way in, which is why the hearing rule
//! has one implementation.
//!
//! Measured on a Pi before anything was written: `webrtc` 0.21.1 carries ICE, DTLS, SRTP and RTP with no
//! GStreamer, and ships no codec, so Opus is this crate's business. `opus` and `magnum-opus` cannot build on
//! aarch64 (both route through `opusic-sys` and an unguarded x86 macro); `audiopus` builds against the system
//! libopus in seconds, so it is the one here.
//!
//! Still open, not to be papered over: whether a browser and this crate actually speak, what libopus costs on
//! Windows where pkg-config does not exist, and what a browser gave for free — echo cancellation, jitter,
//! device choice.

use audiopus::{
    coder::{Decoder, Encoder},
    Application, Channels, SampleRate,
};

/// Twenty milliseconds at 48 kHz: the frame Opus is normally fed, and the one packet that goes on the wire.
pub const FRAME: usize = 960;

/// A mouth: one encoded packet per frame, whatever comes in.
pub fn mouth() -> Result<Encoder, audiopus::Error> {
    Encoder::new(SampleRate::Hz48000, Channels::Mono, Application::Voip)
}

/// An ear: one frame out per packet in.
pub fn ear() -> Result<Decoder, audiopus::Error> {
    Decoder::new(SampleRate::Hz48000, Channels::Mono)
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use rtc::media::Sample;
    use rtc::media_stream::MediaStreamTrack;
    use rtc::peer_connection::configuration::interceptor_registry::register_default_interceptors;
    use rtc::peer_connection::configuration::media_engine::{MIME_TYPE_OPUS, MediaEngine};
    use rtc::peer_connection::transport::RTCIceCandidateInit;
    use rtc::rtp_transceiver::rtp_sender::{
        RTCRtpCodec, RTCRtpCodecParameters, RTCRtpCodingParameters, RTCRtpEncodingParameters,
        RtpCodecKind,
    };
    use webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample;
    use webrtc::media_stream::track_local::TrackLocal;
    use webrtc::media_stream::track_remote::{TrackRemote, TrackRemoteEvent};
    use webrtc::media_stream::Track;
    use webrtc::peer_connection::{
        PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler,
        RTCPeerConnectionIceEvent, RTCPeerConnectionState, Registry,
    };
    use webrtc::runtime::{default_runtime, timeout};

    /// The smallest honest thing: a tone goes in, a packet comes out, and the tone comes back. Everything
    /// the shell will do — hold a conversation, mix two of them — stands on this not being broken.
    #[test]
    fn a_tone_survives_the_round_trip() {
        let mouth = mouth().expect("an encoder");
        let tone: Vec<i16> = (0..FRAME)
            .map(|i| {
                let t = i as f32 / 48_000.0;
                (f32::sin(t * 2.0 * std::f32::consts::PI * 440.0) * 12_000.0) as i16
            })
            .collect();

        let mut packet = [0u8; 512];
        let len = mouth.encode(&tone[..], &mut packet[..]).expect("an encoded frame");
        assert!(len > 0, "an encoded frame has to be more than nothing");
        assert!(len < 512, "a frame of voice should not fill a packet by accident");

        let mut ear = ear().expect("a decoder");
        let mut back = vec![0i16; FRAME];
        let got = ear
            .decode(Some(&packet[..len]), &mut back[..], false)
            .expect("a decoded frame");
        assert_eq!(got, FRAME, "a decoded frame is a frame");

        let loudest = back.iter().map(|s| s.unsigned_abs()).max().unwrap_or(0);
        assert!(loudest > 3_000, "the tone has to come back, not silence: {loudest}");
    }

    /// One Opus codec, one payload type, no format parameters: the single capability both peers
    /// register. The transport ships no codec, so the application names it.
    fn opus() -> RTCRtpCodecParameters {
        RTCRtpCodecParameters {
            rtp_codec: RTCRtpCodec {
                mime_type: MIME_TYPE_OPUS.to_owned(),
                clock_rate: 48_000,
                channels: 2,
                sdp_fmtp_line: String::new(),
                rtcp_feedback: vec![],
            },
            payload_type: 120,
        }
    }

    /// A media engine that knows Opus and the default interceptor chain over it — the plumbing a
    /// peer connection needs before it can carry anything.
    fn engine() -> (MediaEngine, Registry) {
        let mut media_engine = MediaEngine::default();
        media_engine
            .register_codec(opus(), RtpCodecKind::Audio)
            .expect("Opus registers as an audio codec");
        let registry = register_default_interceptors(Registry::new(), &mut media_engine)
            .expect("the default interceptor chain builds");
        (media_engine, registry)
    }

    /// What a connection hands the application: the candidates it gathered, whether it is fully
    /// connected, and any remote track that arrived.
    #[derive(Clone, Default)]
    struct Ear {
        candidates: Arc<Mutex<Vec<RTCIceCandidateInit>>>,
        connected: Arc<AtomicBool>,
        remote: Arc<Mutex<Option<Arc<dyn TrackRemote>>>>,
    }

    impl Ear {
        fn take_candidates(&self) -> Vec<RTCIceCandidateInit> {
            std::mem::take(&mut *self.candidates.lock().expect("candidates lock"))
        }

        fn is_connected(&self) -> bool {
            self.connected.load(Ordering::Acquire)
        }

        fn remote(&self) -> Option<Arc<dyn TrackRemote>> {
            self.remote.lock().expect("remote lock").clone()
        }
    }

    #[async_trait::async_trait]
    impl PeerConnectionEventHandler for Ear {
        async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
            if let Ok(init) = event.candidate.to_json() {
                self.candidates.lock().expect("candidates lock").push(init);
            }
        }

        async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
            if state == RTCPeerConnectionState::Connected {
                self.connected.store(true, Ordering::Release);
            }
        }

        async fn on_track(&self, track: Arc<dyn TrackRemote>) {
            *self.remote.lock().expect("remote lock") = Some(track);
        }
    }

    /// A tone in the shape of one Opus frame: 20 ms of 440 Hz at 48 kHz, starting at `offset`.
    fn a_frame_of_tone(offset: u32) -> Vec<i16> {
        (0..FRAME)
            .map(|n| {
                let t = (offset + n as u32) as f32 / 48_000.0;
                (f32::sin(t * 2.0 * std::f32::consts::PI * 440.0) * 12_000.0) as i16
            })
            .collect()
    }

    /// Two peers in one process — offer, answer and candidates hand-carried, no network and no
    /// server — with an Opus track from the first to the second. The proof is the packets that
    /// actually arrive on the far side, each one decoded back to a frame: the tone this crate
    /// encodes is the tone the other end receives.
    #[test]
    fn a_frame_of_voice_crosses_the_connection() {
        let runtime = default_runtime().expect("a built-in async runtime");
        let driver = Arc::clone(&runtime);

        runtime.block_on(Box::pin(async move {
            let speaker = Ear::default();
            let listener = Ear::default();

            let (offerer_engine, offerer_registry) = engine();
            let (answerer_engine, answerer_registry) = engine();

            let offerer = PeerConnectionBuilder::new()
                .with_media_engine(offerer_engine)
                .with_interceptor_registry(offerer_registry)
                .with_runtime(Arc::clone(&driver))
                .with_handler(Arc::new(speaker.clone()))
                .with_udp_addrs(vec!["127.0.0.1:0"])
                .build()
                .await
                .expect("the speaking peer builds");
            let answerer = PeerConnectionBuilder::new()
                .with_media_engine(answerer_engine)
                .with_interceptor_registry(answerer_registry)
                .with_runtime(Arc::clone(&driver))
                .with_handler(Arc::new(listener.clone()))
                .with_udp_addrs(vec!["127.0.0.1:0"])
                .build()
                .await
                .expect("the hearing peer builds");

            let track = Arc::new(
                TrackLocalStaticSample::new(
                    Instant::now(),
                    MediaStreamTrack::new(
                        "office".to_owned(),
                        "voice".to_owned(),
                        "a colleague".to_owned(),
                        RtpCodecKind::Audio,
                        vec![RTCRtpEncodingParameters {
                            rtp_coding_parameters: RTCRtpCodingParameters {
                                ssrc: Some(0x0FF1CE),
                                ..Default::default()
                            },
                            codec: opus().rtp_codec,
                            ..Default::default()
                        }],
                    ),
                )
                .expect("the Opus track packetizes"),
            );
            let sender = offerer
                .add_track(Arc::clone(&track) as Arc<dyn TrackLocal>)
                .await
                .expect("the track is offered");

            // The handshake, hand-carried: nothing here leaves the process. No signalling server,
            // no file, no socket but the loopback pair ICE itself needs.
            let offer = offerer.create_offer(None).await.expect("an offer");
            offerer
                .set_local_description(offer.clone())
                .await
                .expect("the offer is set locally");
            answerer
                .set_remote_description(offer)
                .await
                .expect("the offer is set remotely");
            let answer = answerer.create_answer(None).await.expect("an answer");
            answerer
                .set_local_description(answer.clone())
                .await
                .expect("the answer is set locally");
            offerer
                .set_remote_description(answer)
                .await
                .expect("the answer is set remotely");

            // Trickle each side's gathered candidates to the other until ICE and DTLS are up.
            let mut connected = false;
            for _ in 0..100 {
                for candidate in speaker.take_candidates() {
                    answerer.add_ice_candidate(candidate).await.ok();
                }
                for candidate in listener.take_candidates() {
                    offerer.add_ice_candidate(candidate).await.ok();
                }
                if speaker.is_connected() && listener.is_connected() {
                    connected = true;
                    break;
                }
                driver.sleep(Duration::from_millis(20)).await;
            }
            assert!(connected, "the two peers have to connect over loopback");

            let payload_type = sender
                .get_parameters()
                .await
                .expect("the sender's parameters")
                .rtp_parameters
                .codecs
                .first()
                .map(|codec| codec.payload_type)
                .expect("a negotiated Opus payload type");
            let ssrc = track.ssrcs().await[0];

            let mouth = mouth().expect("an encoder");
            let frames = 8u32;
            for i in 0..frames {
                let tone = a_frame_of_tone(i * FRAME as u32);
                let mut packet = [0u8; 512];
                let len = mouth
                    .encode(&tone[..], &mut packet[..])
                    .expect("an encoded frame");
                let mut sample = Sample::new(Instant::now());
                sample.data = packet[..len].to_vec().into();
                sample.duration = Duration::from_millis(20);

                track
                    .write_sample(ssrc, payload_type, &sample, &[])
                    .await
                    .expect("a frame written to the track");
                driver.sleep(Duration::from_millis(20)).await;
            }

            // The far side only opens a track once the first packet reaches it, so it appears
            // *after* we start sending, never before.
            let mut incoming = None;
            for _ in 0..100 {
                if let Some(remote) = listener.remote() {
                    incoming = Some(remote);
                    break;
                }
                driver.sleep(Duration::from_millis(20)).await;
            }
            let incoming = incoming.expect("the hearing peer sees a track arrive");

            // Count only what the far side actually received, and hold each payload to the
            // contract: one Opus packet decodes to exactly one 20 ms frame of voice.
            let mut ear = ear().expect("a decoder");
            let mut packets = 0usize;
            let mut decoded = 0usize;
            let mut bytes = 0usize;
            while packets < frames as usize {
                match timeout(driver.as_ref(), Duration::from_secs(1), incoming.poll()).await {
                    Ok(Some(TrackRemoteEvent::OnRtpPacket(packet))) => {
                        packets += 1;
                        bytes += packet.payload.len();
                        let mut back = vec![0i16; FRAME];
                        decoded += ear
                            .decode(Some(packet.payload.as_ref()), &mut back[..], false)
                            .expect("the arrived packet decodes");
                    }
                    Ok(Some(_)) => {}
                    Ok(None) => break,
                    Err(_) => break,
                }
            }

            assert!(packets > 0, "at least one packet has to cross the connection");
            assert!(bytes > 0, "an arrived packet carries Opus, not nothing");
            assert_eq!(
                decoded,
                packets * FRAME,
                "each arrived packet has to be one 20 ms frame of voice"
            );
        }));
    }
}
