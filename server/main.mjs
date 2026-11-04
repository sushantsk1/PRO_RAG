import { loadConfig } from './config.mjs';
import { createApp } from './app.mjs';

const config = loadConfig();
const { app, service } = createApp(config);
const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(`PRO_RAG API listening at http://127.0.0.1:${config.port}/api/v1`);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      service.close();
      process.exit(0);
    });
  });
}
