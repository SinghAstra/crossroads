import type { Server } from 'node:http';

let isShuttingDown = false;

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function shutdown(
  server: Server,
  closeResources: () => Promise<void>,
  signal: NodeJS.Signals,
): Promise<void> {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  console.log(`Received ${signal}. Shutting down.`);
  await closeServer(server);
  await closeResources();
}
