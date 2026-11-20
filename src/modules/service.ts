/** Glue between Zotero UI and the sync engine. */
import {
  pairDevice,
  RemarkableCloud,
  registerDevice,
} from "../remarkable/cloud";
import {
  accountIdentity,
  accountNamespace,
  loadCredential,
  storeCredential,
  removeCredential,
} from "./credentials";
import { uuid4 } from "../remarkable/hash";
import { SyncEngine, type SyncReport } from "../sync/engine";
import { Mutex } from "../sync/mutex";
import { SyncStateStore } from "../sync/state";
import { pdfAttachments } from "../sync/zotero";
import { t } from "../l10n";
import { notify, progress } from "../notify";
import { getPref, setPref } from "../prefs";

import { reviewEntries } from "../sync/review";

declare const reviewPrompt: {
  select(
    win: Window,
    title: string,
    message: string,
    choices: string[],
    selected: { value: number },
  ): boolean;
};

declare function createCloudTimeoutSignal(milliseconds: number): AbortSignal;

export class RemarkableService {
  private engine?: SyncEngine;
  private timerGeneration = 0;
  /** Shared by every engine so a replaced engine cannot overlap a running one. */
  private readonly lock = new Mutex();
  private account = "";
  private token = "";
  state!: SyncStateStore;

  async initialize() {
    const login = await loadCredential(async (account) => {
      const folder = PathUtils.join(
        Zotero.DataDirectory.dir,
        "remarkable-sync",
      );
      await SyncStateStore.migrateLegacy(
        PathUtils.join(folder, "state.json"),
        PathUtils.join(folder, `state-${account}.json`),
      );
    });
    if (login) this.activate(login.password, login.username);
  }

  private activate(token: string, account: string) {
    if (!/^[a-f0-9]{64}$/.test(account))
      throw new Error("Invalid account identifier");
    this.account = account;
    this.token = token;
    this.engine = undefined;
    const file = `state-${account}.json`;
    this.state = new SyncStateStore(
      PathUtils.join(Zotero.DataDirectory.dir, "remarkable-sync", file),
    );
  }

  libraries() {
    return Zotero.Libraries.getAll().filter((lib) =>
      ["user", "group"].includes(lib.libraryType),
    );
  }

  private selections(): Record<string, number[]> {
    const value = JSON.parse(getPref("selectedLibraries") || "{}");
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !Object.values(value).every(
        (ids) => Array.isArray(ids) && ids.every(Number.isSafeInteger),
      )
    )
      throw new Error("Invalid library settings");
    return value;
  }

  eligible = (id: number) => {
    if (!this.connected || !this.selections()[this.account]?.includes(id))
      return false;
    const lib = this.libraries().find((l) => l.libraryID === id);
    return !!lib?.editable && !!lib.filesEditable;
  };

  selectLibrary(id: number, enable: boolean) {
    if (!this.connected) return;
    const all = this.selections();
    const ids = new Set(all[this.account] ?? []);
    if (enable) ids.add(id);
    else ids.delete(id);
    all[this.account] = [...ids];
    setPref("selectedLibraries", JSON.stringify(all));
  }

  private scoped(items: Zotero.Item[]) {
    return pdfAttachments(items, this.eligible);
  }

  /** True while a sync, tablet removal or re-import cleanup is running or queued. */
  get busy() {
    return this.lock.locked;
  }

  get connected() {
    return !!this.token;
  }

  private getEngine(): SyncEngine {
    if (!this.connected) throw new Error(t("error-not-connected"));
    if (!this.engine) {
      const account = this.account;
      const cloud = new RemarkableCloud({
        fetch: fetch.bind(globalThis),
        timeoutSignal: createCloudTimeoutSignal,
        deviceToken: this.token,
        onUserToken: async (user) => {
          accountNamespace(await accountIdentity(user, this.token), account);
        },
        clientId: this.deviceId(),
        log: (m) => Zotero.debug(`[reMarkable] ${m}`),
      });
      const engine: SyncEngine = new SyncEngine(
        cloud,
        this.state,
        () => ({
          folder: getPref("folder") ?? "",
          appendNotesPages: getPref("appendNotesPages"),
          importHandwriting: getPref("importHandwriting"),
        }),
        this.deviceId(),
        this.lock,
        (id) =>
          account === this.account &&
          this.engine === engine &&
          this.eligible(id),
      );
      this.engine = engine;
    }
    return this.engine;
  }

  private deviceId() {
    let id = getPref("deviceId");
    if (!id) {
      id = uuid4();
      setPref("deviceId", id);
    }
    return id;
  }

  /** Pair with the reMarkable cloud using a one-time code. */
  async connect(code: string) {
    if (getPref("deviceToken")) await this.initialize();
    const deviceId = this.deviceId();
    let account = "";
    await this.lock.run(() =>
      pairDevice({
        register: () =>
          registerDevice(
            fetch.bind(globalThis),
            code,
            deviceId,
            createCloudTimeoutSignal,
          ),
        // Validate before storing so a bad token never reaches the preferences.
        validate: async (token) => {
          const user = await new RemarkableCloud({
            fetch: fetch.bind(globalThis),
            timeoutSignal: createCloudTimeoutSignal,
            deviceToken: token,
          }).refreshUserToken();
          account = accountNamespace(await accountIdentity(user, token));
        },
        store: async (token) => {
          await storeCredential(token, account);
          this.activate(token, account);
          await this.state.load();
        },
      }),
    );
  }

  async disconnect() {
    await this.lock.run(async () => {
      await removeCredential();
      this.token = "";
      this.account = "";
      this.engine = undefined;
    });
  }

  /** Items tagged with the sync tag. */
  private async taggedItems(): Promise<Zotero.Item[]> {
    const tag = getPref("syncTag");
    if (!tag) return [];
    const out: Zotero.Item[] = [];
    for (const lib of this.libraries()) {
      if (!this.eligible(lib.libraryID)) continue;
      const s = new Zotero.Search({ libraryID: lib.libraryID });
      s.addCondition("tag", "is", tag);
      const ids = await s.search();
      if (this.eligible(lib.libraryID)) out.push(...Zotero.Items.get(ids));
    }
    return out;
  }

  async syncSelected(items: Zotero.Item[]) {
    const engine = this.getEngine();
    const atts = await this.scoped(items);
    if (!atts.length) {
      notify(t("error-no-pdf"), true);
      return;
    }
    await this.run(engine, atts);
  }

  async syncAll(silent = false) {
    if (!this.libraries().some((lib) => this.eligible(lib.libraryID))) {
      if (!silent)
        notify("Select a library in reMarkable settings to sync papers.");
      return;
    }
    const engine = this.getEngine();
    const atts = new Map<number, Zotero.Item>();
    for (const a of await engine.trackedAttachments()) atts.set(a.id, a);
    for (const a of await this.scoped(await this.taggedItems()))
      atts.set(a.id, a);
    await this.run(engine, [...atts.values()], silent);
  }

  async removeFromTablet(items: Zotero.Item[]) {
    const engine = this.getEngine();
    let n = 0;
    for (const att of await this.scoped(items)) {
      if (
        this.eligible(att.libraryID) &&
        Zotero.getMainWindow().confirm(
          "Move “" +
            att.getDisplayTitle() +
            "” to the tablet Trash? Imported Zotero items will be kept.",
        ) &&
        (await engine.remove(att))
      )
        n++;
    }
    notify(t("removed-docs", { count: n }));
  }

  async removeImported(items: Zotero.Item[], reimport: boolean) {
    const engine = this.getEngine();
    const attachments = await this.scoped(items);
    const n = await engine.removeImported(attachments, reimport);
    if (reimport) {
      const tracked = attachments.filter(
        (a) => this.eligible(a.libraryID) && this.state.get(a.libraryID, a.key),
      );
      await this.run(engine, tracked);
    } else notify(t("removed-imported", { count: n }));
  }

  isTracked(item: Zotero.Item) {
    if (!this.eligible(item.libraryID)) return false;
    const atts = item.isPDFAttachment()
      ? [item]
      : item.isRegularItem()
        ? Zotero.Items.get(item.getAttachments())
        : [];
    return atts.some((a) => this.state.get(a.libraryID, a.key));
  }

  private async run(engine: SyncEngine, atts: Zotero.Item[], silent = false) {
    const popup = silent ? undefined : progress(t("sync-start"));
    let report: SyncReport;
    try {
      report = await engine.sync(atts, (text, fraction) =>
        popup?.update(text, Math.round((fraction ?? 0) * 100)),
      );
    } catch (e) {
      Zotero.logError(e as Error);
      popup?.finish("Sync incomplete · " + (e as Error).message, true);
      if (silent) notify("Sync incomplete · " + (e as Error).message, true);
      return;
    }
    const needsReview = this.state
      .all()
      .some(
        (doc) => this.eligible(doc.libraryID) && reviewEntries(doc).length > 0,
      );
    const status = needsReview
      ? "Review needed · "
      : report.errors.length
        ? "Sync incomplete · "
        : "";
    popup?.finish(
      status +
        t("sync-done", {
          uploaded: report.uploaded,
          updated: report.updated,
          imported: report.imported,
          removed: report.removed,
          notes: report.notes,
        }),
      report.errors.length > 0,
      report.errors,
      report.notices,
    );
    if (silent && report.errors.length && !needsReview)
      notify(report.errors[0], true);
    if (silent && report.notices.length) notify(report.notices[0]);
    if (needsReview) {
      if (silent)
        notify("Review needed · Open Review sync conflicts in Tools.");
      else if (
        Zotero.getMainWindow().confirm(
          "Review needed. Open Review sync conflicts now?",
        )
      )
        await this.reviewConflicts();
    }
  }

  async reviewConflicts() {
    const account = this.account;
    await this.state.load();
    const win = Zotero.getMainWindow();
    const rows = this.state.all().flatMap((doc) => {
      if (!this.eligible(doc.libraryID) || !reviewEntries(doc).length)
        return [];
      const att = Zotero.Items.getByLibraryAndKey(
        doc.libraryID,
        doc.attachmentKey,
      );
      if (!att || att.deleted) return [];
      const library = this.libraries().find(
        (l) => l.libraryID === doc.libraryID,
      );
      return reviewEntries(doc).map(([id, review]) => ({
        doc,
        att,
        id,
        review,
        title: [library?.name, att.getDisplayTitle(), review.location].join(
          " · ",
        ),
      }));
    });
    if (!rows.length) {
      notify("No pending reviews in selected libraries.");
      return;
    }
    const selected = { value: 0 };
    if (
      !reviewPrompt.select(
        win,
        "Review sync conflicts",
        "Choose a paper or note",
        rows.map((r) => r.title),
        selected,
      )
    )
      return;
    const row = rows[selected.value];
    if (!row || account !== this.account || !this.eligible(row.doc.libraryID))
      return;
    const review = row.review;
    const choices = ["Decide later", ...review.choices];
    const action = { value: 0 };
    const message = [
      row.title,
      review.reason,
      "Zotero: " + (review.zotero ?? "Preserved; no comparison available"),
      "Tablet: " + (review.tablet ?? "Unable to verify"),
    ].join("\n\n");
    if (
      !reviewPrompt.select(
        win,
        "Review sync conflicts",
        message,
        choices,
        action,
      ) ||
      !action.value
    )
      return;
    if (account !== this.account) return;
    const report = await this.getEngine().resolve(
      row.att,
      row.id,
      review.revision,
      review.choices[action.value - 1],
    );
    notify(
      report.errors.join("\n") || "Review decision applied.",
      !!report.errors.length,
    );
  }

  /** (Re)start the periodic background sync from preferences. */
  scheduleAutoSync() {
    // Each schedule gets a generation number; stale timers become no-ops.
    // Zotero.setTimeout is used because plugin sandboxes may lack timers.
    const generation = ++this.timerGeneration;
    const minutes = Number(getPref("autoSyncMinutes")) || 0;
    if (minutes <= 0) return;
    const tick = () => {
      if (generation !== this.timerGeneration) return;
      const next = () =>
        (Zotero as any).setTimeout(tick, Math.max(5, minutes) * 60_000);
      if (!this.connected) return next();
      this.syncAll(true)
        .catch((e) => Zotero.logError(e))
        .finally(next);
    };
    (Zotero as any).setTimeout(tick, Math.max(5, minutes) * 60_000);
  }

  shutdown() {
    this.timerGeneration++;
    this.token = "";
    this.engine = undefined;
  }
}
