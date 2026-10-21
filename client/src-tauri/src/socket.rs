//! The one connection to the server, held by the shell rather than the webview: a webview offers no way past an
//! unknown certificate, and the house issues its own. The shell trusts exactly the certificate the app was built
//! with, byte for byte, and refuses every other one.

use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, WebPkiSupportedAlgorithms};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{CertificateError, ClientConfig, DigitallySignedStruct, SignatureScheme};
use serde::Serialize;
use tauri::ipc::Channel;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async_tls_with_config, Connector};

/// The socket the app was built for, written by `build.rs`.
pub const SOCKET: &str = env!("OFFICE_MUMBLE_SOCKET");

/// What the webview is told, in order, on the channel it opened the connection with.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SocketEvent {
    Open,
    Message { text: String },
    /// The connection could not be made, said in words a person can act on.
    Failed { reason: String },
    Closed,
}

enum Outgoing {
    Text(String),
    Close,
}

/// The connection in use, as the way to reach it. Opening another one closes this one first: one person, one
/// connection.
pub struct Socket {
    outgoing: Mutex<Option<mpsc::UnboundedSender<Outgoing>>>,
    tls: Arc<ClientConfig>,
    /// The two certificates compared the last time a handshake was refused: the verifier is the only place that
    /// sees both, so the refusal writes here and the sentence carries them.
    mismatch: Arc<Mutex<Option<String>>>,
}

impl Socket {
    pub fn new() -> Self {
        let mismatch = Arc::new(Mutex::new(None));
        Socket { outgoing: Mutex::new(None), tls: house_tls(mismatch.clone()), mismatch }
    }

    fn replace(&self, next: Option<mpsc::UnboundedSender<Outgoing>>) {
        let previous = std::mem::replace(&mut *self.outgoing.lock().unwrap_or_else(|p| p.into_inner()), next);
        if let Some(previous) = previous {
            let _ = previous.send(Outgoing::Close);
        }
    }
}

#[tauri::command]
pub fn socket_open(socket: tauri::State<Socket>, events: Channel<SocketEvent>) {
    let (sender, receiver) = mpsc::unbounded_channel();
    socket.replace(Some(sender));
    tauri::async_runtime::spawn(run(socket.tls.clone(), socket.mismatch.clone(), receiver, events));
}

#[tauri::command]
pub fn socket_send(socket: tauri::State<Socket>, text: String) {
    if let Some(sender) = socket.outgoing.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
        let _ = sender.send(Outgoing::Text(text));
    }
}

#[tauri::command]
pub fn socket_close(socket: tauri::State<Socket>) {
    socket.replace(None);
}

async fn run(
    tls: Arc<ClientConfig>,
    mismatch: Arc<Mutex<Option<String>>>,
    mut outgoing: mpsc::UnboundedReceiver<Outgoing>,
    events: Channel<SocketEvent>,
) {
    let connected = connect_async_tls_with_config(SOCKET, None, true, Some(Connector::Rustls(tls))).await;
    let stream = match connected {
        Ok((stream, _)) => stream,
        Err(error) => {
            let why = mismatch.lock().unwrap_or_else(|p| p.into_inner()).clone();
            let _ = events.send(SocketEvent::Failed { reason: in_words(&error, why.as_deref()) });
            let _ = events.send(SocketEvent::Closed);
            return;
        }
    };
    let _ = events.send(SocketEvent::Open);
    let (mut sink, mut incoming) = stream.split();
    loop {
        tokio::select! {
            message = incoming.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    let _ = events.send(SocketEvent::Message { text: text.to_string() });
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
            next = outgoing.recv() => match next {
                Some(Outgoing::Text(text)) => {
                    if sink.send(Message::text(text)).await.is_err() {
                        break;
                    }
                }
                Some(Outgoing::Close) | None => {
                    let _ = sink.close().await;
                    break;
                }
            },
        }
    }
    let _ = events.send(SocketEvent::Closed);
}

/// Why a connection failed, as the status bar says it: a certificate refusal carries both fingerprints, because
/// "not the one this app was built for" is acted on by comparing two numbers.
fn in_words(error: &tokio_tungstenite::tungstenite::Error, mismatch: Option<&str>) -> String {
    let text = error.to_string();
    if text.contains("certificate") {
        match mismatch {
            Some(what) => format!("der Server zeigt nicht das Zertifikat, für das diese App gebaut ist: {what}"),
            None => "der Server zeigt nicht das Zertifikat, für das diese App gebaut ist".to_string(),
        }
    } else {
        format!("{SOCKET} antwortet nicht ({text})")
    }
}

/// A certificate's SHA-256, written the way `openssl x509 -noout -fingerprint -sha256` writes it — so the same
/// command run on the server and on this machine can be held next to each other and read off.
fn fingerprint(certificate: &CertificateDer<'_>) -> String {
    ring::digest::digest(&ring::digest::SHA256, certificate.as_ref())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// TLS that trusts the house's certificate and nothing else.
fn house_tls(mismatch: Arc<Mutex<Option<String>>>) -> Arc<ClientConfig> {
    let pem = include_bytes!(concat!(env!("OUT_DIR"), "/house-cert.pem"));
    let certificate = CertificateDer::from_pem_slice(pem).expect("build.rs checked there is a certificate");
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier =
        HouseCertificate { certificate, algorithms: provider.signature_verification_algorithms, mismatch };
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("ring offers the default protocol versions")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    Arc::new(config)
}

/// The one certificate the app accepts. Signatures are still checked against it, so the server must hold the
/// key; only the question of who vouched for it is skipped, because the build already answered it.
#[derive(Debug)]
struct HouseCertificate {
    certificate: CertificateDer<'static>,
    algorithms: WebPkiSupportedAlgorithms,
    mismatch: Arc<Mutex<Option<String>>>,
}

impl ServerCertVerifier for HouseCertificate {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if end_entity.as_ref() == self.certificate.as_ref() {
            Ok(ServerCertVerified::assertion())
        } else {
            let said = format!(
                "er zeigt {}, diese App wurde für {} gebaut",
                fingerprint(end_entity),
                fingerprint(&self.certificate)
            );
            *self.mismatch.lock().unwrap_or_else(|p| p.into_inner()) = Some(said);
            Err(rustls::Error::InvalidCertificate(CertificateError::ApplicationVerificationFailure))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A refusal over the certificate names both of them, in the shape the command line prints them, because
    /// "the server shows not the certificate this app was built for" is acted on by comparing two numbers.
    #[test]
    fn a_refused_certificate_names_both_fingerprints() {
        let error = failure("invalid peer certificate: ApplicationVerificationFailure");
        assert_eq!(
            in_words(&error, None),
            "der Server zeigt nicht das Zertifikat, für das diese App gebaut ist"
        );
        let said = in_words(&error, Some("er zeigt AA:BB, diese App wurde für CC:DD gebaut"));
        assert!(said.contains("AA:BB") && said.ends_with("gebaut"), "{said}");
    }

    /// Everything that is not about a certificate keeps the address and the host's own words: a person acts on
    /// *No route to host* and on a refused connection differently.
    #[test]
    fn anything_else_keeps_the_hosts_own_words() {
        let said = in_words(&failure("No route to host (os error 65)"), None);
        assert!(said.starts_with(SOCKET), "{said}");
        assert!(said.contains("os error 65"), "{said}");
    }

    /// The one SHA-256 everybody knows, so the shape is right: uppercase, two hex digits, colons between.
    #[test]
    fn a_fingerprint_is_written_the_way_openssl_writes_it() {
        let certificate = CertificateDer::from(b"abc".to_vec());
        assert_eq!(
            fingerprint(&certificate),
            "BA:78:16:BF:8F:01:CF:EA:41:41:40:DE:5D:AE:22:23:B0:03:61:A3:96:17:7A:9C:B4:10:FF:61:F2:00:15:AD"
        );
    }

    fn failure(text: &str) -> tokio_tungstenite::tungstenite::Error {
        tokio_tungstenite::tungstenite::Error::Io(std::io::Error::other(text))
    }
}
