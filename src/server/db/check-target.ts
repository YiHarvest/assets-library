import { loadConfig } from "@/server/config";

const config = loadConfig();
const { hostname, port, database } = config.databaseTarget;

console.log(
  `Database target verified: mode=${config.APP_MODE} target=${hostname}:${port}/${database}`,
);
