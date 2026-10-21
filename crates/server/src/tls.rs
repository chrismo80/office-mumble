//! The certificate we issue in the house: made on the first start, reused while it fits this machine, made anew
//! when it does not — and the server has no plaintext port to fall back to. A client that would accept any
//! certificate is not one this project ships.

use std::net::{IpAddr, UdpSocket};
use std::path::{Path, PathBuf};

use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum_server::tls_rustls::RustlsConfig;
use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair, SanType};

use crate::fail;

/// Where the certificate lives. One place, so the file the server hands out is the file it uses.
/// Where the certificate and its key live. `pub(crate)` so a test avatar's colleague process can be handed the
/// same file this server serves and pins.
pub(crate) fn cert_dir() -> PathBuf {
    PathBuf::from(std::env::var("OFFICE_MUMBLE_CERT_DIR").unwrap_or_else(|_| ".office-mumble".to_string()))
}

/// The public half, handed out so a person can install it in one go instead of clicking through a
/// warning on every machine. The private half never leaves the disk it was made on.
pub async fn certificate_file() -> Response {
    let path = cert_dir().join("cert.pem");
    match std::fs::read(&path) {
        Ok(pem) => ([(header::CONTENT_TYPE, "application/x-pem-file")], pem).into_response(),
        Err(e) => (StatusCode::NOT_FOUND, format!("no certificate to hand out at {}: {e}", path.display()))
            .into_response(),
    }
}

/// The certificate and key the server listens with. Issued when there is none, and issued anew — over the old
/// pair — when the pair cannot work or no longer names this machine. Otherwise it is reused: every app pins these
/// exact bytes, so a new certificate is a rebuild of every app.
pub async fn certificate() -> RustlsConfig {
    let dir = cert_dir();
    let (cert_path, key_path) = (dir.join("cert.pem"), dir.join("key.pem"));
    let names = certificate_names();
    if let Some(why) = reason_to_issue(&cert_path, &key_path, &names) {
        issue(&dir, &cert_path, &key_path, &names, &why);
    }
    match RustlsConfig::from_pem_file(&cert_path, &key_path).await {
        Ok(config) => config,
        // Two files from different keys (rustls says KeyMismatch) cannot be a working server, and nobody is
        // connected through them.
        Err(e) => {
            issue(&dir, &cert_path, &key_path, &names, &format!("the pair did not load: {e}"));
            RustlsConfig::from_pem_file(&cert_path, &key_path)
                .await
                .unwrap_or_else(|e| fail(&format!("cannot load {}: {e}", cert_path.display())))
        }
    }
}

/// Why the pair on disk will not do, or `None` when it will: both halves there, readable, and naming every name
/// this machine has right now. A name the certificate lacks is a browser that refuses the socket.
fn reason_to_issue(cert_path: &Path, key_path: &Path, names: &[String]) -> Option<String> {
    match (cert_path.is_file(), key_path.is_file()) {
        (false, false) => return Some("there was none".to_string()),
        (true, true) => {}
        _ => return Some("one half of the pair was missing".to_string()),
    }
    let Some(have) = std::fs::read_to_string(cert_path).ok().and_then(|pem| names_in(&pem)) else {
        return Some("the certificate could not be read".to_string());
    };
    let missing = missing_names(&have, names);
    (!missing.is_empty()).then(|| format!("it did not name {}", missing.join(", ")))
}

/// The names a certificate is for, as written in its Subject Alternative Name.
fn names_in(pem: &str) -> Option<Vec<String>> {
    let params = CertificateParams::from_ca_cert_pem(pem).ok()?;
    Some(
        params
            .subject_alt_names
            .iter()
            .filter_map(|san| match san {
                SanType::DnsName(name) => Some(name.as_str().to_string()),
                SanType::IpAddress(address) => Some(address.to_string()),
                _ => None,
            })
            .collect(),
    )
}

/// What `want` has and `have` lacks. Host names are compared the way DNS compares them, without case.
fn missing_names(have: &[String], want: &[String]) -> Vec<String> {
    want.iter()
        .filter(|name| !have.iter().any(|had| had.eq_ignore_ascii_case(name)))
        .cloned()
        .collect()
}

/// A self-signed certificate for these names and its key, both as PEM.
fn make(names: &[String]) -> (String, String) {
    let mut params = CertificateParams::new(names.to_vec())
        .unwrap_or_else(|e| fail(&format!("cannot prepare a certificate: {e}")));
    let mut subject = DistinguishedName::new();
    subject.push(DnType::CommonName, "office-mumble in the house");
    params.distinguished_name = subject;
    let key = KeyPair::generate().unwrap_or_else(|e| fail(&format!("cannot make a key: {e}")));
    let cert = params.self_signed(&key).unwrap_or_else(|e| fail(&format!("cannot sign the certificate: {e}")));
    (cert.pem(), key.serialize_pem())
}

fn issue(dir: &Path, cert_path: &Path, key_path: &Path, names: &[String], why: &str) {
    let (cert, key) = make(names);
    std::fs::create_dir_all(dir).unwrap_or_else(|e| fail(&format!("{}: {e}", dir.display())));
    write_private(key_path, key.as_bytes());
    std::fs::write(cert_path, cert).unwrap_or_else(|e| fail(&format!("{}: {e}", cert_path.display())));
    println!("issued a certificate ({why}) for: {}", names.join(", "));
    println!("  trust it once per machine: {}", cert_path.display());
    if why != "there was none" {
        println!("  an app built against the one before refuses this server until it is built again");
    }
}

/// The key, readable by its owner only where the file system can say so. Windows has no mode bits; there
/// the key is as private as the directory it lives in.
fn write_private(path: &Path, bytes: &[u8]) {
    std::fs::write(path, bytes).unwrap_or_else(|e| fail(&format!("{}: {e}", path.display())));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    // Windows has no mode bits: the key would inherit the folder's permissions. The inherited entries are cut
    // and the file given to the server's account and the system's. A failure is said out loud — a key more
    // readable than it should be is worth a line in the console.
    #[cfg(windows)]
    {
        let user = std::env::var("USERNAME").unwrap_or_default();
        let mut grant = Vec::new();
        if !user.trim().is_empty() {
            grant.push(format!("{}:(F)", user.trim()));
        }
        grant.push("*S-1-5-18:(F)".to_string());
        match std::process::Command::new("icacls")
            .arg(path)
            .arg("/inheritance:r")
            .arg("/grant:r")
            .args(&grant)
            .output()
        {
            Ok(out) if out.status.success() => {}
            Ok(out) => eprintln!(
                "the key at {} may be readable by more than its owner: icacls said {}",
                path.display(),
                String::from_utf8_lossy(&out.stderr).trim()
            ),
            Err(e) => eprintln!(
                "the key at {} may be readable by more than its owner: icacls could not be started ({e})",
                path.display()
            ),
        }
    }
}

/// Every name somebody may reach this machine by. The certificate has to carry them all, or the browser
/// refuses the socket — and a socket has no "proceed anyway" to click.
fn certificate_names() -> Vec<String> {
    names_for(
        machine_name().as_deref(),
        local_address().ok(),
        std::env::var("OFFICE_MUMBLE_NAMES").ok().as_deref(),
    )
}

/// What this machine is called: `COMPUTERNAME`, `/etc/hostname`, `HOSTNAME`. A certificate without it is one a
/// browser only accepts by address.
fn machine_name() -> Option<String> {
    let asked = |key: &str| {
        std::env::var(key)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    asked("COMPUTERNAME").or_else(|| {
        std::fs::read_to_string("/etc/hostname")
            .ok()
            .map(|host| host.trim().to_string())
            .filter(|host| !host.is_empty())
    })
    .or_else(|| asked("HOSTNAME"))
}

/// The list itself, given what the machine has and what was asked for on the command line — one place, so it can
/// be asked what it does without a network interface to ask.
fn names_for(hostname: Option<&str>, address: Option<IpAddr>, extra: Option<&str>) -> Vec<String> {
    let mut names = vec!["localhost".to_string(), "127.0.0.1".to_string(), "::1".to_string()];
    if let Some(host) = hostname {
        names.push(host.to_string());
        // The name a home network actually resolves, and the one people are told: `<host>.local` over mDNS. A
        // certificate without it makes the advertised name the one that fails.
        if !host.contains('.') {
            names.push(format!("{host}.local"));
        }
    }
    if let Some(address) = address {
        names.push(address.to_string());
    }
    if let Some(extra) = extra {
        names.extend(extra.split(',').map(|name| name.trim().to_string()).filter(|name| !name.is_empty()));
    }
    names.sort();
    names.dedup();
    names
}

/// The address the kernel would use to leave the house. Nothing is sent.
fn local_address() -> std::io::Result<IpAddr> {
    let socket = UdpSocket::bind("0.0.0.0:0")?;
    socket.connect("8.8.8.8:80")?;
    Ok(socket.local_addr()?.ip())
}

#[cfg(test)]
mod tests {
    use super::{make, missing_names, names_for, names_in, reason_to_issue};
    use std::path::PathBuf;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|name| name.to_string()).collect()
    }

    /// An empty folder of its own per test, so tests running side by side never share a pair.
    fn folder(test: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("office-mumble-tls-{}-{test}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_certificate_is_read_back_with_every_name_it_was_issued_for() {
        let issued = names(&["127.0.0.1", "192.168.1.20", "::1", "localhost", "werkstatt", "werkstatt.local"]);
        let (cert, _key) = make(&issued);
        let read = names_in(&cert).expect("our own certificate is readable");
        assert!(missing_names(&read, &issued).is_empty(), "read back: {read:?}");
    }

    #[test]
    fn a_machine_with_a_new_address_or_name_is_missing_from_the_old_certificate() {
        let have = names(&["127.0.0.1", "192.168.1.20", "localhost", "werkstatt"]);
        let want = names(&["127.0.0.1", "192.168.1.21", "localhost", "WERKSTATT", "werkstatt.local"]);
        // The case of a host name is not a difference; the new address and the new name are.
        assert_eq!(missing_names(&have, &want), names(&["192.168.1.21", "werkstatt.local"]));
    }

    #[test]
    fn a_pair_is_kept_while_it_names_this_machine_and_issued_anew_when_it_does_not() {
        let dir = folder("pair");
        let (cert_path, key_path) = (dir.join("cert.pem"), dir.join("key.pem"));
        let here = names(&["127.0.0.1", "192.168.1.20", "localhost"]);

        assert_eq!(reason_to_issue(&cert_path, &key_path, &here).as_deref(), Some("there was none"));

        let (cert, key) = make(&here);
        std::fs::write(&cert_path, cert).unwrap();
        assert_eq!(
            reason_to_issue(&cert_path, &key_path, &here).as_deref(),
            Some("one half of the pair was missing")
        );

        std::fs::write(&key_path, key).unwrap();
        assert_eq!(reason_to_issue(&cert_path, &key_path, &here), None, "a fitting pair is kept");

        let moved = names(&["127.0.0.1", "192.168.1.21", "localhost"]);
        assert_eq!(
            reason_to_issue(&cert_path, &key_path, &moved).as_deref(),
            Some("it did not name 192.168.1.21")
        );

        std::fs::write(&cert_path, "not a certificate").unwrap();
        assert_eq!(
            reason_to_issue(&cert_path, &key_path, &here).as_deref(),
            Some("the certificate could not be read")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_certificate_carries_the_machine_s_own_name_and_whatever_was_asked_for() {
        // Whatever the platform called the machine ends up in the list, together with the address it answers on
        // and whatever `OFFICE_MUMBLE_NAMES` adds — sorted, without duplicates and without empty entries.
        let names = names_for(
            Some("werkstatt"),
            Some("192.168.1.20".parse().unwrap()),
            Some("werkstatt.local, ,werkstatt"),
        );
        assert_eq!(
            names,
            vec!["127.0.0.1", "192.168.1.20", "::1", "localhost", "werkstatt", "werkstatt.local"]
        );
    }

    #[test]
    fn the_name_a_home_network_resolves_is_in_the_certificate_without_being_asked_for() {
        // A bare name gets the form mDNS actually answers — otherwise the name people are told is the one
        // that fails.
        let names = names_for(Some("werkstatt"), Some("192.168.1.20".parse().unwrap()), None);
        assert!(names.contains(&"werkstatt.local".to_string()), "names: {names:?}");

        // A name that already carries a domain is left as it is.
        let names = names_for(Some("office.example.org"), None, None);
        assert!(!names.iter().any(|name| name.ends_with(".org.local")), "names: {names:?}");
    }

    #[test]
    fn a_machine_that_knows_nothing_about_itself_still_gets_a_certificate() {
        // A certificate nobody can use is worse than one issued for the loopback names: the server still starts,
        // and a person who needs a name adds it through `OFFICE_MUMBLE_NAMES`.
        assert_eq!(names_for(None, None, None), vec!["127.0.0.1", "::1", "localhost"]);
    }
}
