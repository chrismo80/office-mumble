//! The house this app is built for: the server's address, written down once at build time. Shared with
//! `build.rs`, which turns whatever was given in `OFFICE_MUMBLE_SERVER` into the socket the app opens, so a
//! malformed address fails the build rather than a colleague's first start.

/// The port the server listens on unless somebody says otherwise.
pub const SERVER_PORT: u16 = 8787;

/// The socket an address leads to, however it was written — a bare host, a host and a port, or a whole URL as a
/// browser shows it. Always over TLS, because the server has no plaintext port; `None` for something that names
/// no host.
pub fn socket_url(given: &str) -> Option<String> {
    let given = given.trim();
    let without_scheme = given.split_once("://").map_or(given, |(_, rest)| rest);
    let host_and_port = without_scheme.split(['/', '?', '#']).next().unwrap_or("");
    if host_and_port.is_empty() || host_and_port.contains(['@', ' ', '\t']) {
        return None;
    }
    let (host, port) = match host_and_port.rsplit_once(':') {
        Some((host, port)) => (host, port.parse::<u16>().ok()?),
        None => (host_and_port, SERVER_PORT),
    };
    if host.is_empty() {
        return None;
    }
    Some(format!("wss://{host}:{port}/ws"))
}

#[cfg(test)]
mod tests {
    use super::socket_url;

    #[test]
    fn a_bare_host_leads_to_the_socket_over_tls_on_the_server_port() {
        assert_eq!(socket_url("MYPC").as_deref(), Some("wss://MYPC:8787/ws"), "a host alone must get the server port");
        assert_eq!(socket_url(" 10.0.0.5 ").as_deref(), Some("wss://10.0.0.5:8787/ws"), "spaces round a host must not count");
    }

    #[test]
    fn a_port_that_was_given_is_kept() {
        assert_eq!(socket_url("10.0.0.5:9000").as_deref(), Some("wss://10.0.0.5:9000/ws"), "a given port must be kept");
    }

    #[test]
    fn an_address_as_a_browser_shows_it_is_accepted_and_never_leaves_tls() {
        assert_eq!(socket_url("https://10.0.0.5:8787/").as_deref(), Some("wss://10.0.0.5:8787/ws"));
        assert_eq!(socket_url("http://10.0.0.5:8787/?name=Probe").as_deref(), Some("wss://10.0.0.5:8787/ws"));
        assert_eq!(socket_url("wss://10.0.0.5:8787/ws").as_deref(), Some("wss://10.0.0.5:8787/ws"));
    }

    #[test]
    fn something_that_names_no_host_leads_nowhere() {
        for given in ["", "   ", "https://", "nobody@10.0.0.5", "a b", "host:port", ":8787"] {
            assert_eq!(socket_url(given), None, "{given:?} must not be taken for a server address");
        }
    }
}
