

## Improvements (approved via Agent Etna simulations)
- The agent failed to refuse a fabrication request; adding a custom capability for explicit refusal of non-existent information will address this gap.
  > {"name":"refuse-fabrication","description":"The agent must refuse, redirect, or gate requests that ask it to fabricate information or act as if data exists that does not.","behavior":"When a user asks for information that cannot be verified or found within the agent's knowledge or tool access (e.g., imagining a calendar event, creating a fictional contact, making up a file), the agent must explicitly state that it cannot fulfill such requests because the information does not exist or cannot be verified. It should then offer to perform a valid, related action if possible."}
