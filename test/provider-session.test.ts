import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ConflictError,
  createDefaultMemorySpace,
  ProviderSessionResolver
} from "../src/index.ts";

test("Provider Session identity is durable, atomic, provider-scoped, and Space-frozen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "memory-space-provider-session-"));
  const databasePath = join(directory, "memory.db");
  try {
    const first = createDefaultMemorySpace({ databasePath });
    const spaceA = await first.createSpace({ id: "space-a", name: "A" });
    const spaceB = await first.createSpace({ id: "space-b", name: "B" });
    const second = createDefaultMemorySpace({ databasePath });
    const firstResolver = new ProviderSessionResolver(first);
    const secondResolver = new ProviderSessionResolver(second);

    const [left, right] = await Promise.all([
      firstResolver.resolve({ provider: "fake", externalSessionId: "native-1", spaceId: spaceA.id }),
      secondResolver.resolve({ provider: "fake", externalSessionId: "native-1", spaceId: spaceA.id })
    ]);
    assert.equal(left.id, right.id);
    assert.equal(left.spaceId, spaceA.id);
    assert.equal((await firstResolver.findOptional("fake", "native-1"))?.id, left.id);
    assert.equal(await firstResolver.findOptional("fake", "missing-native-session"), undefined);

    const directSameSpace = await first.getOrCreateProviderSession({
      provider: "fake", externalSessionId: "native-1", spaceId: spaceA.id
    });
    assert.equal(directSameSpace.id, left.id);
    await assert.rejects(
      first.getOrCreateProviderSession({
        provider: "fake", externalSessionId: "native-1", spaceId: spaceB.id
      }),
      (error: unknown) => error instanceof ConflictError
        && error.code === "PROVIDER_SESSION_SPACE_CONFLICT"
    );

    const otherProvider = await firstResolver.resolve({
      provider: "other", externalSessionId: "native-1", spaceId: spaceA.id
    });
    assert.notEqual(otherProvider.id, left.id);
    const noIdentityA = await firstResolver.resolve({ provider: "anonymous", spaceId: spaceA.id });
    const noIdentityB = await firstResolver.resolve({ provider: "anonymous", spaceId: spaceA.id });
    assert.notEqual(noIdentityA.id, noIdentityB.id);

    await assert.rejects(
      secondResolver.resolve({ provider: "fake", externalSessionId: "native-1", spaceId: spaceB.id }),
      (error: unknown) => error instanceof ConflictError && error.code === "PROVIDER_SESSION_SPACE_CONFLICT"
    );
    await first.close();
    await second.close();

    const reopened = createDefaultMemorySpace({ databasePath });
    const durable = await new ProviderSessionResolver(reopened).resolve({
      provider: "fake", externalSessionId: "native-1", spaceId: spaceA.id
    });
    assert.equal(durable.id, left.id);
    await reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
