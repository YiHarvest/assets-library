import Script from "next/script";
import { apiV1Path } from "@/lib/paths";

export const metadata = { title: "API 文档 · 素材库" };

export default function ApiDocsPage() {
  const stylesheetUrl = process.env.SWAGGER_UI_STYLESHEET_URL?.trim();
  const bundleUrl = process.env.SWAGGER_UI_BUNDLE_URL?.trim();
  if (!stylesheetUrl || !bundleUrl) {
    throw new Error("Swagger UI asset URLs must be configured in the environment.");
  }
  return (
    <main className="min-h-[calc(100vh-3.5rem)] bg-white dark:bg-[#1c1c1e]">
      <link rel="stylesheet" href={stylesheetUrl} />
      <div id="swagger-ui" />
      <Script src={bundleUrl} strategy="afterInteractive" />
      <Script id="swagger-ui-init" strategy="afterInteractive">
        {`(() => {
          const mount = () => {
            if (!window.SwaggerUIBundle) return window.setTimeout(mount, 50);
            window.SwaggerUIBundle({
              url: "${apiV1Path("/openapi")}",
              dom_id: "#swagger-ui",
              deepLinking: true,
              persistAuthorization: true,
            });
          };
          mount();
        })();`}
      </Script>
    </main>
  );
}
