import { loadConfig } from "@/server/config";

const testEnvironment = {
  PRD_INTERNAL_SERVICE_HOST: "your.com",
  DATABASE_URL: "mysql://root@localhost/assets_library_dev_test",
  SCENE_DETECT_BASE_URL: "https://your.com",
  CHROMA_URL: "https://your.com",
} as const;

export function loadTestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return loadConfig({ ...testEnvironment, ...env });
}
