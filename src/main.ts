import { App } from "./app";
import { parseConfig } from "./config";

try {
  const config = parseConfig(process.argv.slice(2));
  const app = new App(config);
  await app.run();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
