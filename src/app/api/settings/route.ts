import { connection } from "next/server";
import { agentModels, InvalidModelChoiceError } from "@/lib/agent-models";
import { isModelAgent, type ModelAgentName, type ModelChoice } from "@/lib/factory-agents";

export async function GET() {
  await connection();
  return Response.json(await agentModels.view());
}

const isChoice = (value: unknown): value is ModelChoice =>
  typeof value === "object" && value !== null && typeof (value as ModelChoice).provider === "string" && typeof (value as ModelChoice).model === "string";

/** Saves per-agent models: `{ agents: { implement: { provider, model } | null, ... } }`; null falls back to MOZAIK_MODEL. Applies from each agent's next run. */
export async function PUT(request: Request) {
  const { agents } = (await request.json().catch(() => ({}))) as { agents?: Record<string, unknown> };
  if (typeof agents !== "object" || agents === null) return Response.json({ error: "agents must be an object" }, { status: 400 });
  const choices: Partial<Record<ModelAgentName, ModelChoice | null>> = {};
  for (const [agent, choice] of Object.entries(agents)) {
    if (!isModelAgent(agent)) return Response.json({ error: `unknown agent: ${agent}` }, { status: 400 });
    if (choice !== null && !isChoice(choice)) return Response.json({ error: `${agent}: expected { provider, model } or null` }, { status: 400 });
    choices[agent] = choice;
  }
  try {
    await agentModels.save(choices);
  } catch (error) {
    if (error instanceof InvalidModelChoiceError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
  return Response.json(await agentModels.view());
}
