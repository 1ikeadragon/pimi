// Runs as ssh's SSH_ASKPASS program (through bin/pimi-ssh-askpass), in a plain Node process with no
// Electron. It asks the desktop for the answer over the local askpass channel and prints it.
// It never reads stdin: that is ssh's data pipe when the tunnel runs.
import { connect } from "node:net";

const socketPath = process.env.PIMI_SSH_ASKPASS_SOCK;
const token = process.env.PIMI_SSH_ASKPASS_TOKEN;
const prompt = process.argv[2] ?? "";

if (!socketPath || !token) process.exit(1);

let reply = "";
const socket = connect(socketPath);
socket.setEncoding("utf8");
socket.on("connect", () => {
  socket.write(`${token}\n${Buffer.from(prompt, "utf8").toString("base64")}\n`);
});
socket.on("data", (chunk: string) => {
  reply += chunk;
});
socket.on("error", () => process.exit(1));
socket.on("close", () => {
  const line = reply.split("\n", 1)[0] ?? "";
  if (!line.startsWith("OK ")) process.exit(1);
  const secret = Buffer.from(line.slice(3), "base64");
  process.stdout.write(Buffer.concat([secret, Buffer.from("\n")]), () => process.exit(0));
});
