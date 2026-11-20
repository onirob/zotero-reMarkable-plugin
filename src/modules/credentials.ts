import { sha256Hex } from "../remarkable/hash";
import { getPref, setPref } from "../prefs";

interface Login {
  password: string;
  username: string;
  init(
    origin: string,
    form: null,
    realm: string,
    user: string,
    pass: string,
    userField: string,
    passField: string,
  ): void;
}
declare const credentialManager: {
  searchLoginsAsync(query: {
    origin: string;
    httpRealm: string;
  }): Promise<Login[]>;
  addLoginAsync(login: Login): Promise<unknown>;
  modifyLogin(old: Login, replacement: Login): void;
  removeLogin(login: Login): void;
};
declare function newCredential(): Login;
const origin = "chrome://zoteroremarkable";
const realm = "reMarkable Sync device";
async function current() {
  const logins = await credentialManager.searchLoginsAsync({
    origin,
    httpRealm: realm,
  });
  if (logins.length > 1)
    throw new Error("Multiple reMarkable credentials found");
  return logins[0];
}
/** The user token is supplied by a successful exchange with the fixed auth host. */
export async function accountIdentity(userToken: string, deviceToken: string) {
  const claims = JSON.parse(
    atob(userToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
  );
  const subject = claims["auth0-userid"] || claims.sub || claims.UserID;
  const identity =
    typeof subject === "string" && subject
      ? JSON.stringify([claims.iss ?? "", subject])
      : deviceToken;
  return sha256Hex(new TextEncoder().encode(identity));
}

export function accountNamespace(identity: string, active?: string) {
  const bindings: Record<string, string> = JSON.parse(
    getPref("accountBindings") || "{}",
  );
  if (
    !bindings ||
    typeof bindings !== "object" ||
    Array.isArray(bindings) ||
    Object.entries(bindings).some(
      ([key, value]) =>
        !/^[a-f0-9]{64}$/.test(key) || !/^[a-f0-9]{64}$/.test(value),
    )
  )
    throw new Error("Invalid account bindings");
  const namespace = active ?? bindings[identity] ?? identity;
  if (
    (bindings[identity] && bindings[identity] !== namespace) ||
    Object.entries(bindings).some(
      ([key, value]) => value === namespace && key !== identity,
    )
  )
    throw new Error("The connected account differs from the saved pairing");
  if (!bindings[identity]) {
    bindings[identity] = namespace;
    setPref("accountBindings", JSON.stringify(bindings));
  }
  return namespace;
}

export async function storeCredential(token: string, account: string) {
  const old = await current();
  const login = newCredential();
  login.init(origin, null, realm, account, token, "", "");
  if (old) credentialManager.modifyLogin(old, login);
  else await credentialManager.addLoginAsync(login);
  const verified = await current();
  if (verified?.password !== token || verified.username !== account)
    throw new Error("Credential save could not be verified");
}
export async function loadCredential(
  migrateState: (account: string) => Promise<void>,
) {
  const old = getPref("deviceToken");
  let login = await current();
  if (old) {
    if (login && login.password !== old)
      throw new Error("Stored device credentials disagree");
    const account =
      login?.username ?? (await sha256Hex(new TextEncoder().encode(old)));
    if (!/^[a-f0-9]{64}$/.test(account))
      throw new Error("Invalid saved account identifier");
    await migrateState(account);
    await storeCredential(old, account);
    login = await current();
    setPref("deviceToken", "");
  }
  return login;
}
export async function removeCredential() {
  const login = await current();
  if (login) credentialManager.removeLogin(login);
  if (await current()) throw new Error("Could not disconnect device");
}
