import type { ModelType } from "@curvet/sdk";
import type { ResolvedProfile } from "./config.js";
import { makeClient } from "./client.js";

/**
 * Pick a model: --model flag > profile default (chat only) > first model of the
 * right type in the app's catalogue.
 */
export async function pickModel(
  profile: ResolvedProfile,
  flag: string | undefined,
  type: ModelType,
): Promise<string> {
  if (flag) return flag;
  if (type === "chat" && profile.defaultModel) return profile.defaultModel;
  const client = makeClient(profile);
  const models = await client.models.list({ type });
  if (models.length === 0) {
    throw new Error(
      `No ${type} models are available to this app — pass --model explicitly, or check \`curvet models\`.`,
    );
  }
  return models[0].id;
}
