import type { RememberInput } from "../src/index.ts";

const validRememberInput: RememberInput = {
  spaceId: "space", family: "state", type: "goal", content: "Valid Indexed write"
};

const invalidRememberInput: RememberInput = {
  spaceId: "space", family: "state", type: "goal", content: "Invalid Core bypass",
  // @ts-expect-error Public remember input must not accept a tier.
  tier: "core"
};

void validRememberInput;
void invalidRememberInput;
