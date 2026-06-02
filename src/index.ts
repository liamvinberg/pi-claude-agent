import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { claudeAgentTool } from "./tool";

export default function claudeAgentExtension(pi: ExtensionAPI): void {
	pi.registerTool(claudeAgentTool);
}
