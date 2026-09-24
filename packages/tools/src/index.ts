import { androidProviders } from './packs/android.js';
import { browserProvider } from './packs/browser.js';
import { browserPageOperations } from './packs/browser-session.js';
import { cloudflareProvider } from './packs/cloudflare.js';
import { cloudflareApiProvider } from './packs/cloudflare-api.js';
import { credentialProvider } from './packs/credential-broker.js';
import { databaseProviders } from './packs/database.js';
import { dockerProvider } from './packs/docker.js';
import { filesystemProvider } from './packs/filesystem.js';
import { githubProvider } from './packs/github.js';
import { githubApiProvider } from './packs/github-api.js';
import { gitProvider } from './packs/git.js';
import { hostedProviders } from './packs/hosted.js';
import { httpProviders } from './packs/http.js';
import { installerProvider } from './packs/installer.js';
import { networkProviders } from './packs/network.js';
import { runtimeProviders } from './packs/runtime.js';
import { shellProviders } from './packs/shell.js';
import { verifyProvider } from './packs/verify.js';
import { webProvider } from './packs/web.js';
import { windowsProvider } from './packs/windows.js';
import type { ToolProvider } from './sdk.js';

export * from './sdk.js';
export * from './registry.js';
export * from './router.js';
export * from './profiles.js';
export * from './policy.js';
export * from './recovery.js';
export * from './verification.js';
export * from './environment.js';
export * from './health.js';
export * from './paths.js';
export * from './net-guard.js';
export * from './sql.js';
export { expandPackageScripts } from './package-scripts.js';
export { clip, detectExecutable, firstVersion, localBin, run as runCommand } from './detect.js';
export { classifyScript } from './packs/shell.js';
export { packageManager, declaredDependencies } from './packs/runtime.js';
export { waitForHttp, isLoopbackUrl, classifyRequest } from './packs/http.js';
export { checkPage, findBrowser, VIEWPORTS } from './packs/browser.js';
export { closeBrowserPages, closeAllBrowserPages, openBrowserPages } from './packs/browser-session.js';
export { verifyWeb, webVerifyInput, type WebVerifyInput } from './packs/verify.js';
export { tcpConnect } from './packs/network.js';
export { globToRegExp } from './packs/filesystem.js';
export { refreshedPath, locateInstalled } from './packs/installer.js';
export { resetCloudflareCatalog } from './packs/cloudflare-api.js';

/** Every built-in provider (V2 plan §6). MCP servers are added at runtime by the gateway. */
export function builtinProviders(): ToolProvider[] {
  return [
    ...shellProviders(),
    filesystemProvider(),
    gitProvider(),
    githubProvider(),
    githubApiProvider(),
    ...runtimeProviders(),
    browserProvider(browserPageOperations()),
    ...httpProviders(),
    webProvider(),
    ...networkProviders(),
    windowsProvider(),
    cloudflareProvider(),
    cloudflareApiProvider(),
    credentialProvider(),
    ...databaseProviders(),
    dockerProvider(),
    ...androidProviders(),
    ...hostedProviders(),
    verifyProvider(),
    installerProvider(),
  ];
}
