import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSol = (model: { provider: string; id: string } | undefined) =>
  model?.provider === "openai-codex" && model.id === "gpt-5.6-sol";

export default function solFast(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("sol-fast", isSol(ctx.model) ? "⚡ fast" : undefined);
  });

  pi.on("model_select", (event, ctx) => {
    ctx.ui.setStatus("sol-fast", isSol(event.model) ? "⚡ fast" : undefined);
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!isSol(ctx.model) || !isRecord(event.payload)) return;
    return { ...event.payload, service_tier: "priority" };
  });
}
