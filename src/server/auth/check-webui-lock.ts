import { readWebUiLockConfig } from "./webui-lock";

const config = readWebUiLockConfig();
process.stdout.write(
  `WebUI lock ${config.enabled ? "enabled" : "disabled"} (APP_MODE=${config.appMode}).\n`,
);
