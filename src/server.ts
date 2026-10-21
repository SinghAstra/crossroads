import { createApp } from './app.ts';
import config from './config/index.ts';
import { closeResources } from './lib/close-resources.ts';
import { shutdown } from './lib/shutdown.ts';

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`Server listening on port ${config.port} in ${config.env} mode`);
});

function handleSignal(signal: NodeJS.Signals): void {
  shutdown(server, closeResources, signal)
    .then(() => {
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}

server.on('error', (error) => {
  console.error(error);
  process.exit(1);
});

process.on('SIGINT', () => handleSignal('SIGINT'));
process.on('SIGTERM', () => handleSignal('SIGTERM'));
