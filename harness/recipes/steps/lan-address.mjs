// This machine's address on the network: the one the system would leave the house by. It is the rule the server
// uses for the address in its certificate (local_address in crates/server/src/tls.rs), so an app built for this
// machine and the certificate it pins name the same address. Cable or Wi-Fi, whatever the adapter is called;
// WSL, Hyper-V and Docker are not on the way out, so they are never the answer.
//
// Nothing is sent: connecting a UDP socket only asks the system which route it would take. Without a network
// it prints nothing and exits 1, and the caller decides what that means. Used by net.sh and the .ps1 steps.
import { createSocket } from 'node:dgram';

const socket = createSocket('udp4');
socket.on('error', () => process.exit(1));
socket.connect(80, '8.8.8.8', () => {
  console.log(socket.address().address);
  socket.close();
});
