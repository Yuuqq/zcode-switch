import { readFileSync } from "node:fs";

globalThis.fetch = async (input) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith("https://zcode.z.ai/api/v1/client/configs?")) {
    return Response.json({ data: { configs: { builtin_provider_config_json: "https://cdn.example.invalid/models.json" } } });
  }
  if (url === "https://cdn.example.invalid/models.json") {
    return Response.json(JSON.parse(readFileSync(new URL("provider-config.json", import.meta.url), "utf8")));
  }
  throw new Error(`Unexpected host smoke network request: ${new URL(url).origin}`);
};
