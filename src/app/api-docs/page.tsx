import Script from "next/script";

export const metadata = { title: "API 文档 · 素材库" };

export default function ApiDocsPage() {
  return (
    <main className="min-h-[calc(100vh-3.5rem)] bg-white dark:bg-[#1c1c1e]">
      <link
        rel="stylesheet"
        href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"
      />
      <div id="swagger-ui" />
      <Script
        src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"
        strategy="afterInteractive"
      />
      <Script id="swagger-ui-init" strategy="afterInteractive">
        {`(() => {
          const mount = () => {
            if (!window.SwaggerUIBundle) return window.setTimeout(mount, 50);
            window.SwaggerUIBundle({
              url: "/api/v1/openapi",
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
