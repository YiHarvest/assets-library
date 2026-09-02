import { forwardRef, type ComponentPropsWithoutRef } from "react";

export const WebUiLink = forwardRef<
  HTMLAnchorElement,
  ComponentPropsWithoutRef<"a">
>(function WebUiLink(props, ref) {
  /*
   * 生产环境只用 assetPrefix + rewrite 暴露页面前缀，Next Router 的 basePath
   * 刻意保持为空。next/link 会把带前缀地址当成客户端路由，RSC 导航无法稳定
   * 对应到重写后的页面，可能直接触发客户端 Application error。
   *
   * WebUI 页面跳转因此统一使用原生链接，让浏览器携带 Cookie 发起完整请求，
   * 再由服务端 rewrite 去掉公开前缀。业务 API 请求不经过这个组件。
   */
  return <a ref={ref} data-webui-navigation="document" {...props} />;
});
