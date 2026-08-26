import { loadConfig } from "./config.js";
import { createGateway } from "./app.js";

const config = loadConfig();
const server = createGateway({ config });

server.listen(config.port, () => {
  console.log(`agent compute gateway listening on :${config.port}`);
  console.log(`connect page: http://localhost:${config.port}/connect`);
});
