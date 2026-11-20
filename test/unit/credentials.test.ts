import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accountIdentity,
  accountNamespace,
  loadCredential,
} from "../../src/modules/credentials";

test("migration clears the old token only after state and credential verification", async () => {
  const g = globalThis as any;
  let old = "device-token";
  let login: any;
  let fail = true;
  g.Zotero = {
    Prefs: {
      get: () => old,
      set: (_k: string, value: string) => {
        old = value;
      },
    },
  };
  g.credentialManager = {
    searchLoginsAsync: async () => (login ? [login] : []),
    addLoginAsync: async (value: unknown) => {
      if (!fail) login = value;
    },
    modifyLogin: (_prior: unknown, value: unknown) => {
      login = value;
    },
  };
  g.newCredential = () => ({
    init(
      _origin: string,
      _form: null,
      _realm: string,
      username: string,
      password: string,
    ) {
      Object.assign(this, { username, password });
    },
  });
  await assert.rejects(
    loadCredential(async () => {
      throw new Error("backup failed");
    }),
    /backup failed/,
  );
  assert.equal(old, "device-token");
  await assert.rejects(
    loadCredential(async () => {}),
    /could not be verified/,
  );
  assert.equal(old, "device-token");
  fail = false;
  const saved = await loadCredential(async (account) => {
    assert.match(account, /^[a-f0-9]{64}$/);
  });
  assert.equal(saved.password, "device-token");
  assert.equal(old, "");
  assert.equal(
    (
      await loadCredential(async () => {
        throw new Error("unexpected migration");
      })
    ).username,
    saved.username,
  );
});

test("validated account identity restores its namespace on re-pair and refuses a switch in place", async () => {
  let bindings = "{}";
  (globalThis as any).Zotero = {
    Prefs: {
      get: () => bindings,
      set: (_k: string, v: string) => {
        bindings = v;
      },
    },
  };
  const jwt = (sub: string) =>
    "header." +
    Buffer.from(JSON.stringify({ sub, iss: "rm" })).toString("base64url") +
    ".sig";
  const alice = await accountIdentity(jwt("alice"), "first token");
  const bob = await accountIdentity(jwt("bob"), "other token");
  const legacy = "a".repeat(64);
  assert.equal(accountNamespace(alice, legacy), legacy);
  assert.equal(
    accountNamespace(await accountIdentity(jwt("alice"), "new token")),
    legacy,
  );
  assert.throws(() => accountNamespace(bob, legacy), /differs/);
  assert.equal(accountNamespace(bob), bob);
});
