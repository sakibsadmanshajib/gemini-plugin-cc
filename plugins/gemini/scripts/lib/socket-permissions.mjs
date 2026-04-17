import process from "node:process";

export function listenOnRestrictedUnixSocket(server, socketPath, onListening) {
  const oldUmask = process.umask(0o177);
  try {
    server.listen(socketPath, onListening);
  } finally {
    process.umask(oldUmask);
  }
}
