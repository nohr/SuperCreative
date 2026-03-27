import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: ({ command }) => ({
    name: "SuperCreative",
    version: "0.1.0",
    key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmP6ngBUsDI3alr4BNTMzdToqqTZfAk1aQKRM5Vwn/ZAViw/Ws46OISNgWrjLSVY9zo12+UgrFMRu/+sBijNT2Lz6RqErf+Wv74ezioonny5waj+Wx8ki1gr8DIOjrQ5COcclIYhqyCr/zyrv5aS8o03q+cnyxh2R1sI5LNkfvfAGtqA6l9rowV6te8PC2393Ms5BwV3rbvDj9AMJ8zYgkiwzqeaTnESkxH9+X5RuDbGXzwqKYnSpDY1wEw00mr3+fKYd04rpqITGfmw8KpM1AsfO72F+Tt/+rixdFz+uSuZX0IqlKS3NQa7M3oUgTov0b3caLeKfNtGnapRoWkNudwIDAQAB",
    permissions: [
      "activeTab",
      "scripting",
      "webNavigation",
      "storage",
      "identity",
      "commands",
    ],
    host_permissions: [
      "*://*.googleusercontent.com/*",
      "*://*.doubleclick.net/*",
      "*://*.googlesyndication.com/*",
      "*://*.2mdn.net/*",
    ],
    oauth2: {
      client_id:
        "846195434653-glqleklt7pglohhfudhf0nd07q2b8b6q.apps.googleusercontent.com",
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    },
    commands: {
      reload: {
        suggested_key: {
          default: "Ctrl+Shift+E",
          mac: "Command+Shift+E",
        },
        description: "reload the extension",
      },
    },
    web_accessible_resources: [
      {
        resources: ["styles-injector.css"],
        matches: ["<all_urls>"],
      },
    ],
    action: {
      default_icon: "icon.png",
    },
    // Allow Vite dev server scripts in dev mode
    ...(command === "serve"
      ? {
          content_security_policy: {
            extension_pages:
              "script-src 'self' http://localhost:* 'wasm-unsafe-eval'; object-src 'self';",
          },
        }
      : {}),
  }),
});
