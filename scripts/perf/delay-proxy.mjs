// A TCP proxy that holds every chunk back by a fixed time in each direction, so a laptop
// database behaves like one an ocean away. Run it between the app and a local Postgres:
//
//   node scripts/perf/delay-proxy.mjs 55433 55432 40     # 40 ms each way = 80 ms round trip
//
// Production reaches its database over roughly that distance (functions in one region,
// Supabase in another); locally every statement costs nothing, which is why a page that
// sends two hundred of them looks fine on a laptop.
import net from "node:net";

const [listenPort, targetPort, oneWayMs] = process.argv.slice(2).map(Number);
if (![listenPort, targetPort, oneWayMs].every(Number.isFinite)) {
  console.error("usage: node scripts/perf/delay-proxy.mjs <listen-port> <target-port> <one-way-ms>");
  process.exit(1);
}

net
  .createServer((client) => {
    const server = net.connect(targetPort, "127.0.0.1");
    // Equal timers fire in the order they were set, so chunks stay in order.
    const relay = (from, to) => from.on("data", (chunk) => setTimeout(() => !to.destroyed && to.write(chunk), oneWayMs));
    relay(client, server);
    relay(server, client);
    const close = () => {
      client.destroy();
      server.destroy();
    };
    for (const socket of [client, server]) socket.on("error", close).on("close", close);
  })
  .listen(listenPort, "127.0.0.1", () => console.log(`proxy ${listenPort} -> ${targetPort}, ${oneWayMs} ms each way`));
