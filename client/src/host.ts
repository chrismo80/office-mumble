/**
 * The host the client runs in, and the narrow seam between the two there are. The browser knows nothing about
 * the machine, so it says "present" for as long as the page is open, and its connection to the server is the
 * page's own WebSocket, trusted as far as the browser trusts the certificate. The shell watches the screen lock
 * and sleep, was built for one house, and holds the connection itself, because it trusts exactly that house's
 * certificate where a webview would trust only what the operating system does.
 *
 * The shell is reached through the global Tauri puts into its own webview, typed here once, so no other module
 * speaks to it by string.
 */

/** The one connection to the server, as the client uses it, whichever host holds it. */
export type Wire = {
  send(text: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((text: string) => void) | null;
  /** It could not be made or it broke; the reason is the host's, in words, or empty when it has none. */
  onerror: ((reason: string) => void) | null;
  onclose: (() => void) | null;
};

export type Host = {
  /** `shell` when the page is the app's window, `browser` when it is a tab. */
  kind: 'browser' | 'shell';
  /** Calls back with the current answer, and again whenever it changes: true is at the machine, false is gone. */
  onPresence(callback: (present: boolean) => void): void;
  /** What the shell was built for: the socket and the name the system knows the person by. `null` in a browser. */
  house(): Promise<House | null>;
  /** Open a connection. A browser opens the address it is given; the shell opens the one it was built for. */
  open(url: string): Wire;
};

export type House = { socket: string; user: string };

type SocketEvent =
  | { kind: 'open' }
  | { kind: 'message'; text: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'closed' };

/** The part of Tauri's global this client uses — the commands and the one event the shell defines. */
type TauriGlobal = {
  core: {
    invoke(command: 'presence'): Promise<boolean>;
    invoke(command: 'house'): Promise<House>;
    invoke(command: 'socket_open', args: { events: unknown }): Promise<void>;
    invoke(command: 'socket_send', args: { text: string }): Promise<void>;
    invoke(command: 'socket_close'): Promise<void>;
    Channel: new <T>() => { onmessage: (message: T) => void };
  };
  event: { listen(event: 'presence', handler: (event: { payload: boolean }) => void): Promise<() => void> };
};

export function host(): Host {
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  return tauri ? shellHost(tauri) : browserHost();
}

function browserHost(): Host {
  return {
    kind: 'browser',
    onPresence: callback => callback(true),
    house: async () => null,
    open(url) {
      const socket = new WebSocket(url);
      const wire: Wire = {
        send: text => socket.send(text),
        close: () => socket.close(),
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
      };
      socket.onopen = () => wire.onopen?.();
      socket.onmessage = event => wire.onmessage?.(String(event.data));
      socket.onerror = () => wire.onerror?.('');
      socket.onclose = () => wire.onclose?.();
      return wire;
    },
  };
}

function shellHost(tauri: TauriGlobal): Host {
  return {
    kind: 'shell',
    onPresence(callback) {
      // Listen first and ask second: a lock that lands between the two is then heard twice rather than never.
      void tauri.event.listen('presence', event => callback(event.payload));
      void tauri.core.invoke('presence').then(callback, () => callback(true));
    },
    house: () => tauri.core.invoke('house'),
    open() {
      // The shell holds one connection; opening another closes the one before, so a wire that is no longer the
      // current one stops hearing its channel the moment it is let go.
      let current = true;
      const wire: Wire = {
        send: text => {
          if (current) void tauri.core.invoke('socket_send', { text });
        },
        close: () => {
          if (!current) return;
          current = false;
          void tauri.core.invoke('socket_close');
        },
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
      };
      const events = new tauri.core.Channel<SocketEvent>();
      events.onmessage = event => {
        if (!current) return;
        if (event.kind === 'open') wire.onopen?.();
        else if (event.kind === 'message') wire.onmessage?.(event.text);
        else if (event.kind === 'failed') wire.onerror?.(event.reason);
        else {
          current = false;
          wire.onclose?.();
        }
      };
      void tauri.core.invoke('socket_open', { events });
      return wire;
    },
  };
}
